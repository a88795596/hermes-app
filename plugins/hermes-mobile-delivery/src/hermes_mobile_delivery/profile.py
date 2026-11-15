"""通过 Hermes 原生工具设置移动端渠道的配置档案头像。"""

import base64
import json
import os
from pathlib import Path
import re
import stat

from gateway.platforms.base import BasePlatformAdapter
from hermes_cli.config import get_env_value_prefer_dotenv

from .inbox import _request, inbox_endpoint


MAX_AVATAR_BYTES = 2 * 1024 * 1024
TOOL_NAME = "hermes_mobile_set_profile_avatar"


def _configuration():
    endpoint = inbox_endpoint(get_env_value_prefer_dotenv("HERMES_MOBILE_INBOX_URL") or "")
    token = get_env_value_prefer_dotenv("HERMES_MOBILE_INBOX_TOKEN") or ""
    return (endpoint, token) if endpoint and re.fullmatch(r"[\x21-\x7e]+", token) else None


def _avatar(path: str) -> dict:
    source = Path(path).expanduser().absolute()
    if source.is_symlink():
        raise ValueError("头像不能是符号链接")
    safe = BasePlatformAdapter.validate_media_delivery_path(str(source))
    if not safe:
        raise ValueError("头像路径不允许上传")
    fd = os.open(safe, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_AVATAR_BYTES:
            raise ValueError("头像必须是非空的普通文件，且不超过 2 MiB")
        content = file.read(MAX_AVATAR_BYTES + 1)
        after = os.fstat(file.fileno())
        if len(content) != info.st_size or after.st_mtime_ns != info.st_mtime_ns or after.st_size != info.st_size:
            raise ValueError("头像文件正在变化")
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        mime, extension = "image/png", "png"
    elif content.startswith(b"\xff\xd8\xff"):
        mime, extension = "image/jpeg", "jpg"
    elif content[:6] in {b"GIF87a", b"GIF89a"}:
        mime, extension = "image/gif", "gif"
    elif content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        mime, extension = "image/webp", "webp"
    else:
        raise ValueError("头像必须为 JPEG、PNG、GIF 或 WebP 图片")
    return {"name": f"avatar.{extension}", "mime": mime, "size": len(content),
            "content_base64": base64.b64encode(content).decode("ascii")}


def set_profile_avatar(args, **_kwargs):
    def failure(message, **details):
        return json.dumps({"success": False, "error": message, **details}, ensure_ascii=False)

    if not isinstance(args, dict) or set(args) != {"profile_ref", "image_path"}:
        return failure("请指定 profile_ref 和本地图片 image_path")
    profile, path = args["profile_ref"], args["image_path"]
    try:
        valid_profile = (isinstance(profile, str) and profile == profile.strip() and bool(profile)
                         and len(profile.encode("utf-8")) <= 64 and not any(ord(char) < 32 for char in profile))
    except UnicodeEncodeError:
        valid_profile = False
    if not valid_profile or not isinstance(path, str) or not path or "\x00" in path:
        return failure("配置档案名称或本地图片路径无效")
    configured = _configuration()
    if not configured:
        return failure("请检查 Hermes 移动端 API 地址和投递令牌")
    try:
        avatar = _avatar(path)
    except (OSError, ValueError, TypeError):
        return failure("头像必须是允许上传的本地 JPEG、PNG、GIF 或 WebP 图片，非符号链接且不超过 2 MiB")
    status, body = _request(*configured, "PUT", "/internal/profiles/v1/avatar",
                            {"profile_ref": profile, "avatar": avatar})
    if status != 200:
        return failure("无法确认头像已更新，请检查配置档案是否在 BFF 允许名单内、凭证和网络后重试",
                       http_status=status)
    try:
        receipt = json.loads(body)
    except (ValueError, RecursionError):
        receipt = None
    data = receipt.get("data") if isinstance(receipt, dict) else None
    if (not isinstance(data, dict) or data.get("label") != profile
            or not all(isinstance(data.get(key), str) and data[key] for key in ("profile_id", "avatar_url"))):
        return failure("服务端头像回执无效，无法确认是否已更新")
    return json.dumps({"success": True, "profile_ref": profile, "profile_id": data["profile_id"],
                       "avatar_url": data["avatar_url"]}, ensure_ascii=False)


def register_profile_tools(ctx):
    ctx.register_tool(
        name=TOOL_NAME,
        toolset="hermes_mobile",
        description="设置 Hermes 移动端配置档案头像",
        schema={
            "name": TOOL_NAME,
            "description": "设置指定 profile 在 Hermes 移动端渠道的头像。仅上传本地图片；不修改其他渠道头像、别名或首页默认档案。",
            "parameters": {
                "type": "object",
                "properties": {
                    "profile_ref": {"type": "string", "description": "BFF 允许的 Hermes 配置档案名称，如 default 或 work；不是别名或 UUID。"},
                    "image_path": {"type": "string", "description": "本地 JPEG、PNG、GIF 或 WebP 图片路径，最多 2 MiB。"},
                },
                "required": ["profile_ref", "image_path"],
                "additionalProperties": False,
            },
        },
        handler=set_profile_avatar,
        check_fn=lambda: _configuration() is not None,
    )
