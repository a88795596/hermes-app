"""Hermes 移动端收件箱和会话投递 API 客户端。"""

from contextlib import closing
import base64
from http.client import HTTPConnection, HTTPException, HTTPSConnection
import json
import logging
from pathlib import Path
import re
from time import sleep
from urllib.parse import SplitResult, urlsplit

from .spool import ack, attachments, delivery_session, pull


logger = logging.getLogger(__name__)


def inbox_endpoint(value: str) -> SplitResult | None:
    if not re.fullmatch(r"[\x21-\x7e]+", value):
        return None
    try:
        endpoint = urlsplit(value)
        if (endpoint.scheme not in {"http", "https"} or not endpoint.hostname or endpoint.port == 0
                or endpoint.username is not None or endpoint.query or endpoint.fragment):
            return None
        return endpoint
    except ValueError:
        return None


def _request(endpoint: SplitResult, token: str, method: str, path: str, payload: dict) -> tuple[int | None, bytes]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    connect = HTTPSConnection if endpoint.scheme == "https" else HTTPConnection
    for attempt in range(3):
        if attempt:
            sleep(0.25 * attempt)
        try:
            with closing(connect(endpoint.hostname, endpoint.port, timeout=30)) as connection:
                connection.request(method, path, body, headers)
                with connection.getresponse() as response:
                    status = response.status
                    receipt = response.read(64 * 1024)
        except (OSError, HTTPException, ValueError):
            status, receipt = None, b""
        if status is not None and status not in (408, 429) and not 500 <= status <= 599:
            return status, receipt
    return status, receipt


def post_delivery(endpoint: SplitResult, token: str, delivery_id: str, profile: str, text: str,
                  files=(), *, session_id: str | None = None) -> int | None:
    payload = {"delivery_id": delivery_id, "profile_ref": profile, "text": text}
    if files:
        payload["attachments"] = files
    if session_id is not None:
        payload["session_id"] = session_id
    return _request(endpoint, token, "POST", endpoint.path or "/", payload)[0]


def deliver_one(path: Path, endpoint: SplitResult, token: str, profile: str, delivery_id: str, text: str) -> bool:
    session_id = delivery_session(path, delivery_id)
    references = []
    for reference, content in attachments(path, delivery_id):
        payload = {"profile_ref": profile, **{key: reference[key] for key in ("name", "mime", "size")},
                   "content_base64": base64.b64encode(content).decode("ascii")}
        status, body = _request(endpoint, token, "PUT", f"/internal/attachments/v1/{reference['attachment_id']}", payload)
        try:
            receipt = json.loads(body)
        except (ValueError, RecursionError):
            receipt = None
        canonical = receipt.get("data") if isinstance(receipt, dict) else None
        mime = canonical.get("mime") if isinstance(canonical, dict) else None
        valid_mime = isinstance(mime, str) and (mime == reference["mime"]
            or mime in {"image/png", "image/jpeg", "image/gif", "image/webp"})
        if (status not in (200, 201) or not valid_mime or canonical != {**reference, "mime": mime}
                or type(canonical.get("size")) is not int):
            logger.warning("Hermes 移动端附件等待重试（投递 ID %s，HTTP 状态 %s）", delivery_id, status)
            return False
        references.append(canonical)
    status = post_delivery(endpoint, token, delivery_id, profile, text, references, session_id=session_id)
    if status != 204:
        logger.warning("Hermes 移动端投递等待重试（投递 ID %s，HTTP 状态 %s）", delivery_id, status)
        return False
    ack(path, delivery_id)
    return True


def deliver_pending(path: Path, endpoint: SplitResult, token: str, profile: str) -> bool:
    pending = pull(path, profile)
    for delivery_id, text in pending:
        if not deliver_one(path, endpoint, token, profile, delivery_id, text):
            # shortcut: 按入队顺序暂停重试，确认单条故障需要独立处置时再引入隔离队列。
            return False
    return bool(pending)
