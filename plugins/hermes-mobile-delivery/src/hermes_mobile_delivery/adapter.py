"""Hermes 网关和独立发送命令的入口。"""

import asyncio
from contextlib import suppress
import json
import hmac
import logging
import os
from pathlib import Path
import re
import sqlite3
from urllib.parse import unquote, urlsplit

from agent.redact import redact_sensitive_text
from gateway.config import Platform
from gateway.platform_registry import PlatformEntry
from gateway.platforms.base import BasePlatformAdapter, SendResult
from hermes_cli.config import get_env_value_prefer_dotenv
from hermes_constants import get_hermes_home

from .inbox import deliver_one, deliver_pending, inbox_endpoint
from .spool import cancel, enqueue, inspect_queue, MAX_ATTACHMENTS, retry


PLATFORM = "hermes_mobile"
HOME_CHANNEL_ENV = "HERMES_MOBILE_HOME_CHANNEL"
MAX_TEXT_BYTES = 128 * 1024
SESSION_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,511}")
logger = logging.getLogger(__name__)


def register_platform(ctx):
    def route():
        profile = ctx.profile_name
        allowed_profile = get_env_value_prefer_dotenv("HERMES_MOBILE_PROFILE") or "default"
        target = get_env_value_prefer_dotenv(HOME_CHANNEL_ENV) or ""
        endpoint = inbox_endpoint(get_env_value_prefer_dotenv("HERMES_MOBILE_INBOX_URL") or "")
        token = get_env_value_prefer_dotenv("HERMES_MOBILE_INBOX_TOKEN") or ""
        path = Path(get_env_value_prefer_dotenv("HERMES_MOBILE_SPOOL_PATH")
                    or get_hermes_home() / "mobile-delivery" / "queue.sqlite3")
        if (profile == allowed_profile and re.fullmatch(r"[0-9]{1,20}", target)
                and endpoint and re.fullmatch(r"[\x21-\x7e]+", token) and path.is_absolute()):
            return profile, target, endpoint, token, path
        return None

    def env_enablement():
        configured = route()
        if configured:
            return {"home_channel": {"chat_id": configured[1], "name": "Hermes 移动端收件箱"}}
        return None

    async def submit(chat_id, message, *, thread_id=None, media_files=None, file_name=None, gateway=False):
        configured = route()
        if (not configured or not isinstance(chat_id, str)
                or not SESSION_ID.fullmatch(chat_id) or thread_id):
            return {"error": "请检查 Hermes 移动端的投递目标、配置档案和 API 凭证"}
        if not isinstance(message, str) or (not message.strip() and not media_files):
            return {"error": "投递到 Hermes 移动端的文本为空"}
        profile, _, endpoint, token, path = configured
        try:
            text = redact_sensitive_text(message.replace(token, "[REDACTED]"), force=True, redact_url_credentials=True)
        except Exception:
            return {"error": "Hermes 移动端无法对投递文本中的敏感信息脱敏"}
        try:
            text_size = len(text.encode("utf-8"))
        except UnicodeEncodeError:
            return {"error": "投递到 Hermes 移动端的文本必须采用有效的 UTF-8 编码"}
        if "\x00" in text:
            return {"error": "投递到 Hermes 移动端的文本含有空字符"}
        if text_size > MAX_TEXT_BYTES:
            return {"error": "投递到 Hermes 移动端的文本超过 128 KiB"}
        files = []
        try:
            if media_files and (not isinstance(media_files, (list, tuple)) or len(media_files) > MAX_ATTACHMENTS):
                raise ValueError("每条消息最多包含 10 个附件")
            for source, _is_voice in media_files or []:
                source = Path(source).expanduser().absolute()
                if source.is_symlink():
                    raise ValueError("附件不能是符号链接")
                safe = BasePlatformAdapter.validate_media_delivery_path(str(source))
                if not safe:
                    raise ValueError("附件不存在或不允许投递")
                files.append((Path(safe), file_name))
        except (OSError, ValueError, TypeError):
            return {"error": "附件不存在、不允许投递或超过每条 10 个的限制"}
        try:
            # shortcut: 每次调用生成 UUID，待 Hermes 提供稳定的分段 ID 后可跨调用去重。
            delivery_id = await asyncio.to_thread(enqueue, path, profile, text, files,
                                                 session_id=None if chat_id == configured[1] else chat_id)
        except (OSError, sqlite3.Error, ValueError):
            return {"error": "无法保存投递队列，请检查磁盘权限、附件名称和单个附件 50 MiB 的限制"}

        delivery_status = "queued"
        if not gateway:
            try:
                delivery_status = await asyncio.to_thread(deliver_one, path, endpoint, token, profile, delivery_id, text)
            except (OSError, sqlite3.Error, ValueError):
                logger.warning("Hermes 移动端无法确认本地队列记录（投递 ID %s）", delivery_id)
        result = {"success": delivery_status != "failed", "message_id": delivery_id,
                  "delivery_reconciliation": "limited", "delivery_status": delivery_status}
        if delivery_status != "delivered":
            note = {"failed": "投递失败，原消息和附件已保留，请通过 mobile-queue 查询或重试",
                    "auth_blocked": "鉴权失败，本配置档案暂停投递，请修正凭证后通过 mobile-queue 重试"}.get(
                        delivery_status, "消息已进入 Hermes 移动端投递队列，尚未送达")
            result["note"] = f"{note}（投递 ID {delivery_id}）"
            if delivery_status == "failed":
                result["error"] = result["note"]
        return result

    async def standalone_send(pconfig, chat_id, message, *, thread_id=None, media_files=None, force_document=False):
        return await submit(chat_id, message, thread_id=thread_id, media_files=media_files)

    class Adapter(BasePlatformAdapter):
        def __init__(self, config):
            super().__init__(config, Platform(PLATFORM))
            self._delivery_task: asyncio.Task | None = None
            self._command_profile = ctx.profile_name
            self._command_home = Path(get_hermes_home()).resolve()
            self._command_replies = {}
            self._command_tasks = {}

        @property
        def authorization_is_upstream(self):
            return True

        def verify_http_event_request(self, authorization):
            try:
                api = self.gateway_runner.adapters.get(Platform("api_server"))
                # 使用 API Server 本身的解析，保留 extra.key 与多档案 secret scope。
                key = api._expected_api_key()
                valid = (isinstance(key, str) and len(key) >= 16 and isinstance(authorization, str)
                         and authorization.startswith("Bearer ")
                         and hmac.compare_digest(key.encode("utf-8"), authorization[7:].encode("utf-8")))
                return bool(valid), "" if valid else "invalid_mobile_command_authorization"
            except Exception:
                return False, "invalid_mobile_command_authorization"

        async def dispatch_http_event(self, payload):
            from .commands import dispatch

            # The API Server owns the shared listener, but secondary profiles
            # own distinct adapters. Only forward inside the API's already
            # authenticated native home scope; the body cannot select a scope.
            profile = payload.get("profile_ref") if isinstance(payload, dict) else None
            if isinstance(profile, str) and profile and profile != self._command_profile:
                profiles = getattr(getattr(self, "gateway_runner", None), "_profile_adapters", {})
                target = profiles.get(profile, {}).get(self.platform)
                if (target is not None and getattr(target, "_command_profile", None) == profile
                        and getattr(target, "_command_home", None) == Path(get_hermes_home()).resolve()):
                    return await target.dispatch_http_event(payload)
            return await dispatch(self, payload, route())

        async def _deliver(self):
            while configured := route():
                profile, _, endpoint, token, path = configured
                try:
                    delivered = await asyncio.to_thread(deliver_pending, path, endpoint, token, profile)
                    if delivered:
                        continue
                except (OSError, sqlite3.Error, ValueError):
                    logger.warning("Hermes 移动端无法处理本地投递队列")
                await asyncio.sleep(5)

        async def connect(self, *, is_reconnect=False):
            if not route():
                return False
            if not self._delivery_task or self._delivery_task.done():
                self._delivery_task = asyncio.create_task(self._deliver())
            self._mark_connected()
            return True

        async def disconnect(self):
            if self._delivery_task:
                self._delivery_task.cancel()
                with suppress(asyncio.CancelledError):
                    await self._delivery_task
                self._delivery_task = None
            self._mark_disconnected()

        async def get_chat_info(self, chat_id):
            configured = route()
            name = "Hermes 移动端收件箱" if configured and chat_id == configured[1] else "Hermes 移动端会话"
            return {"name": name, "type": "channel", "chat_id": chat_id}

        async def send(self, chat_id, content, reply_to=None, metadata=None):
            from .commands import capture_reply

            if await capture_reply(self, chat_id, reply_to, content):
                return SendResult(success=True, message_id=reply_to)
            media_files, content = self.extract_media(content) if isinstance(content, str) and "MEDIA:" in content else ([], content)
            result = await submit(chat_id, content, thread_id=(metadata or {}).get("thread_id"),
                                  media_files=media_files, gateway=True)
            return SendResult(success=bool(result.get("success")), message_id=result.get("message_id"),
                              error=result.get("error"), raw_response=result)

        async def send_document(self, chat_id, file_path, caption=None, file_name=None, reply_to=None, metadata=None, **kwargs):
            result = await submit(chat_id, caption or "", thread_id=(metadata or {}).get("thread_id"),
                                  media_files=[(file_path, False)], file_name=file_name, gateway=True)
            return SendResult(success=bool(result.get("success")), message_id=result.get("message_id"),
                              error=result.get("error"), raw_response=result)

        async def send_image_file(self, chat_id, image_path, caption=None, reply_to=None, metadata=None, **kwargs):
            return await self.send_document(chat_id, image_path, caption, reply_to=reply_to, metadata=metadata)

        async def send_video(self, chat_id, video_path, caption=None, reply_to=None, metadata=None, **kwargs):
            return await self.send_document(chat_id, video_path, caption, reply_to=reply_to, metadata=metadata)

        async def send_voice(self, chat_id, audio_path, caption=None, reply_to=None, metadata=None, **kwargs):
            return await self.send_document(chat_id, audio_path, caption, reply_to=reply_to, metadata=metadata)

        async def send_image(self, chat_id, image_url, caption=None, reply_to=None, metadata=None):
            try:
                url = urlsplit(image_url)
                if url.scheme == "file" and not url.netloc and not url.query and not url.fragment:
                    return await self.send_image_file(chat_id, unquote(url.path), caption, reply_to, metadata)
            except ValueError:
                pass
            return SendResult(success=False, error="请先将图片保存为本地文件，再通过 Hermes 移动端投递")

        async def send_animation(self, chat_id, animation_url, caption=None, reply_to=None, metadata=None):
            return await self.send_image(chat_id, animation_url, caption, reply_to, metadata)

    def setup_cli(parser):
        parser.add_argument("message", nargs="?", default="", help="可选的消息正文")
        parser.add_argument("--file", action="append", default=[], help="附件路径，可重复指定，最多 10 个")
        parser.add_argument("--to", help="hermes_mobile 或 hermes_mobile:<会话 ID>，省略时优先当前移动端会话")

    def send_cli(args):
        configured = route()
        chat_id = configured[1] if configured else ""
        if args.to is not None:
            if args.to.startswith(PLATFORM + ":"):
                chat_id = args.to.removeprefix(PLATFORM + ":")
            elif args.to != PLATFORM:
                chat_id = ""
        else:
            session = os.environ.get("HERMES_SESSION_CHAT_ID", "")
            if (configured and os.environ.get("HERMES_SESSION_PLATFORM") == "api_server"
                    and session.startswith("mobile_") and not os.environ.get("HERMES_CRON_SESSION")
                    and (os.environ.get("HERMES_SESSION_PROFILE") or "default") == configured[0]):
                chat_id = session
        result = asyncio.run(submit(chat_id, args.message,
                                    media_files=[(file, False) for file in args.file]))
        print(json.dumps(result, ensure_ascii=False))
        raise SystemExit(0 if result.get("success") else 1)

    ctx.register_cli_command(name="mobile-send", help="向 Hermes 移动端收件箱或会话发送文本和文件",
                             setup_fn=setup_cli, handler_fn=send_cli)

    def setup_queue_cli(parser):
        commands = parser.add_subparsers(dest="action", required=True)
        listing = commands.add_parser("list", help="查看当前配置档案的未送达、失败和取消记录")
        listing.add_argument("--id", dest="delivery_id", help="只查看指定投递 ID")
        for action, help_text in (("retry", "按原目标和快照重新排队"), ("cancel", "停止投递并保留记录")):
            command = commands.add_parser(action, help=help_text)
            command.add_argument("delivery_id", help="投递 ID")

    def queue_cli(args):
        configured = route()
        result = {"success": False}
        if not configured:
            result["error"] = "请检查 Hermes 移动端的配置档案和 API 凭证"
        else:
            profile, _, _, _, path = configured
            try:
                if args.action != "list" and not {"retry": retry, "cancel": cancel}[args.action](
                        path, profile, args.delivery_id):
                    result["error"] = "记录不存在、已取消或正在投递，未修改队列"
                else:
                    result = {"success": True, "deliveries": inspect_queue(path, profile, args.delivery_id)}
            except (OSError, sqlite3.Error, ValueError):
                result["error"] = "无法处理投递队列，请检查磁盘权限和队列文件"
        print(json.dumps(result, ensure_ascii=False))
        raise SystemExit(0 if result["success"] else 1)

    ctx.register_cli_command(name="mobile-queue", help="查询、重试或取消 Hermes 移动端投递",
                             setup_fn=setup_queue_cli, handler_fn=queue_cli)

    options = {}
    for name in ("parse_target_ref_fn", "target_ref_syntax_fn"):
        if name in PlatformEntry.__dataclass_fields__:
            options[name] = lambda target: (target, None) if SESSION_ID.fullmatch(target) else None
    if "standalone_send" in PlatformEntry.__dataclass_fields__:
        from gateway.platforms.send_targets import StandaloneSendPolicy

        options["standalone_send"] = StandaloneSendPolicy(media=True)
    ctx.register_platform(
        name=PLATFORM,
        label="Hermes 移动端",
        adapter_factory=Adapter,
        check_fn=lambda: True,
        is_connected=lambda config: route() is not None,
        env_enablement_fn=env_enablement,
        cron_deliver_env_var=HOME_CHANNEL_ENV,
        standalone_sender_fn=standalone_send,
        allow_update_command=False,
        **options,
    )
