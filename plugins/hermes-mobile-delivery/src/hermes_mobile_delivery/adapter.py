"""Hermes gateway and standalone send entry points."""

import asyncio
from pathlib import Path
import re
import sqlite3

from agent.redact import redact_sensitive_text
from gateway.config import Platform
from gateway.platform_registry import PlatformEntry
from gateway.platforms.base import BasePlatformAdapter, SendResult
from hermes_cli.config import get_env_value_prefer_dotenv

from .spool import enqueue


PLATFORM = "hermes_mobile"
HOME_CHANNEL_ENV = "HERMES_MOBILE_HOME_CHANNEL"
SPOOL_PATH_ENV = "HERMES_MOBILE_SPOOL_PATH"
MEDIA_ERROR = "Hermes Mobile accepts text only; no attachment was stored"
MAX_TEXT_BYTES = 128 * 1024


def register_platform(ctx):
    def route():
        profile = ctx.profile_name
        allowed_profile = get_env_value_prefer_dotenv("HERMES_MOBILE_PROFILE") or "default"
        target = get_env_value_prefer_dotenv(HOME_CHANNEL_ENV) or ""
        path = Path(get_env_value_prefer_dotenv(SPOOL_PATH_ENV) or "")
        if profile == allowed_profile and re.fullmatch(r"[0-9]{1,20}", target) and path.is_absolute():
            return profile, target, path
        return None

    def env_enablement():
        configured = route()
        if configured:
            return {"home_channel": {"chat_id": configured[1], "name": "Hermes Mobile Inbox"}}
        return None

    async def standalone_send(pconfig, chat_id, message, *, thread_id=None, media_files=None, force_document=False):
        configured = route()
        if not configured or chat_id != configured[1] or thread_id:
            return {"error": "Hermes Mobile target or profile is not configured for delivery"}
        if media_files:
            return {"error": MEDIA_ERROR}
        if not isinstance(message, str) or not message.strip():
            return {"error": "Hermes Mobile delivery text is empty"}
        try:
            text = redact_sensitive_text(message, force=True, redact_url_credentials=True)
        except Exception:
            return {"error": "Hermes Mobile could not redact delivery text"}
        try:
            text_size = len(text.encode("utf-8"))
        except UnicodeEncodeError:
            return {"error": "Hermes Mobile delivery text must be valid UTF-8"}
        if "\x00" in text:
            return {"error": "Hermes Mobile delivery text contains a null character"}
        if text_size > MAX_TEXT_BYTES:
            return {"error": "Hermes Mobile delivery text exceeds 128 KiB"}
        try:
            # shortcut: without a stable upstream part ID, every admission gets a UUID; reuse source IDs once exposed.
            delivery_id = await asyncio.to_thread(enqueue, configured[2], configured[0], text)
        except (OSError, sqlite3.Error, ValueError):
            return {"error": "Hermes Mobile could not persist delivery in the local spool"}
        return {"success": True, "message_id": delivery_id, "delivery_reconciliation": "limited"}

    class Adapter(BasePlatformAdapter):
        def __init__(self, config):
            super().__init__(config, Platform(PLATFORM))

        async def connect(self, *, is_reconnect=False):
            if not route():
                return False
            self._mark_connected()
            return True

        async def disconnect(self):
            self._mark_disconnected()

        async def get_chat_info(self, chat_id):
            return {"name": "Hermes Mobile Inbox", "type": "channel", "chat_id": chat_id}

        async def send(self, chat_id, content, reply_to=None, metadata=None):
            result = await standalone_send(self.config, chat_id, content, thread_id=(metadata or {}).get("thread_id"))
            return SendResult(success=bool(result.get("success")), message_id=result.get("message_id"),
                              error=result.get("error"), raw_response=result)

        async def send_document(self, *args, **kwargs):
            return SendResult(success=False, error=MEDIA_ERROR)

        send_image = send_image_file = send_animation = send_video = send_voice = send_document

    options = {}
    if "standalone_send" in PlatformEntry.__dataclass_fields__:
        from gateway.platforms.send_targets import StandaloneSendPolicy

        options["standalone_send"] = StandaloneSendPolicy(media=True)
    ctx.register_platform(
        name=PLATFORM,
        label="Hermes Mobile",
        adapter_factory=Adapter,
        check_fn=lambda: True,
        is_connected=lambda config: route() is not None,
        env_enablement_fn=env_enablement,
        cron_deliver_env_var=HOME_CHANNEL_ENV,
        standalone_sender_fn=standalone_send,
        allow_update_command=False,
        **options,
    )
