"""通过 Bark API 发送通知。"""

import asyncio
from contextlib import closing
from http.client import HTTPConnection, HTTPException, HTTPSConnection
import json
from urllib.parse import SplitResult

from .inbox import inbox_endpoint


PLATFORM = "bark"
KEY_ENV = "BARK_KEY"
HOME_CHANNEL_ENV = "BARK_HOME_CHANNEL"
DEFAULT_URL = "https://api.day.app"
MEDIA_ERROR = "Bark 支持通过 image 或 soundUrl 传入媒体链接"


def post_bark(endpoint: SplitResult, keys: list[str], message: str) -> dict[str, bool | str]:
    if not isinstance(message, str) or not message.strip():
        return {"error": "Bark 推送内容为空"}
    try:
        payload = json.loads(message) if message.lstrip().startswith("{") else {"body": message}
        if any(key.lower() in {"device_key", "device_keys"} for key in payload):
            return {"error": "请通过 BARK_KEY 配置 Bark 推送设备"}
        payload.setdefault("level", "timeSensitive")
        if len(keys) == 1:
            payload["device_key"] = keys[0]
        else:
            payload["device_keys"] = keys
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (ValueError, RecursionError):
        return {"error": "Bark 推送参数须为有效的 UTF-8 文本或 JSON 对象"}

    path = endpoint.path.rstrip("/")
    if not path.endswith("/push"):
        path += "/push"
    connect = HTTPSConnection if endpoint.scheme == "https" else HTTPConnection
    try:
        with closing(connect(endpoint.hostname, endpoint.port, timeout=5)) as connection:
            connection.request("POST", path, body, {"Content-Type": "application/json; charset=utf-8"})
            with connection.getresponse() as response:
                if response.status != 200:
                    return {"error": f"Bark 投递失败（HTTP {response.status}）"}
                receipt = json.loads(response.read())
    except (OSError, HTTPException):
        return {"error": "无法连接 Bark 或读取投递回执"}
    except (ValueError, RecursionError):
        return {"error": "Bark 返回了无效的投递回执"}

    if not isinstance(receipt, dict) or type(receipt.get("code")) is not int:
        return {"error": "Bark 返回了无效的投递回执"}
    if receipt["code"] != 200:
        return {"error": f"Bark 投递失败（API {receipt['code']}）"}
    if len(keys) > 1:
        results = receipt.get("data")
        if not isinstance(results, list) or len(results) != len(keys):
            return {"error": "Bark 返回了不完整的批量投递回执"}
        sent = sum(isinstance(result, dict) and result.get("code") == 200 for result in results)
        if sent != len(keys):
            return {"error": f"Bark 批量投递仅确认 {sent}/{len(keys)} 台设备"}
    return {"success": True}


def register_bark(ctx):
    from gateway.config import Platform
    from gateway.platform_registry import PlatformEntry
    from gateway.platforms.base import BasePlatformAdapter, SendResult
    from hermes_cli.config import get_env_value_prefer_dotenv

    def route():
        keys = [key.strip() for key in (get_env_value_prefer_dotenv(KEY_ENV) or "").split(",")]
        url = (get_env_value_prefer_dotenv("BARK_URL") or "").strip() or DEFAULT_URL
        endpoint = inbox_endpoint(url)
        return (endpoint, keys) if endpoint and all(keys) else None

    def home_channel():
        return (get_env_value_prefer_dotenv(HOME_CHANNEL_ENV) or "").strip() or "1"

    def env_enablement():
        if route():
            return {"home_channel": {"chat_id": home_channel(), "name": "Bark"}}
        return None

    async def standalone_send(pconfig, chat_id, message, *, thread_id=None, media_files=None, force_document=False):
        configured = route()
        if not configured:
            return {"error": "请检查 BARK_KEY 和 BARK_URL"}
        if chat_id != home_channel() or thread_id:
            return {"error": "请使用 Bark 的默认投递目标"}
        if media_files:
            return {"error": MEDIA_ERROR}
        return await asyncio.to_thread(post_bark, *configured, message)

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
            return {"name": "Bark", "type": "channel", "chat_id": chat_id}

        async def send(self, chat_id, content, reply_to=None, metadata=None):
            result = await standalone_send(self.config, chat_id, content, thread_id=(metadata or {}).get("thread_id"))
            return SendResult(success=bool(result.get("success")), error=result.get("error"), raw_response=result)

        async def send_document(self, *args, **kwargs):
            return SendResult(success=False, error=MEDIA_ERROR)

        send_image = send_image_file = send_animation = send_video = send_voice = send_document

    options = {}
    if "standalone_send" in PlatformEntry.__dataclass_fields__:
        from gateway.platforms.send_targets import StandaloneSendPolicy

        options["standalone_send"] = StandaloneSendPolicy(media=True)
    ctx.register_platform(
        name=PLATFORM,
        label="Bark",
        adapter_factory=Adapter,
        check_fn=lambda: True,
        is_connected=lambda config: route() is not None,
        env_enablement_fn=env_enablement,
        cron_deliver_env_var=HOME_CHANNEL_ENV,
        standalone_sender_fn=standalone_send,
        required_env=[KEY_ENV],
        allow_update_command=False,
        **options,
    )
