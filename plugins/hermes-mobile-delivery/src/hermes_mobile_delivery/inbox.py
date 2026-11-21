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

from .spool import ack, attachments, begin_attempt, delivery_target, due, finish_attempt, renew_attempt


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
                  files=(), *, session_id: str | None = None, notice: dict | None = None) -> tuple[int | None, bytes]:
    payload = {"delivery_id": delivery_id, "profile_ref": profile, "text": text}
    if files:
        payload["attachments"] = files
    if session_id is not None:
        payload["session_id"] = session_id
    if notice is not None:
        payload["notice"] = notice
    return _request(endpoint, token, "POST", endpoint.path or "/", payload)


def _failure(path: Path, profile: str, delivery_id: str, status: int | None, body: bytes,
             *, attempt_token: str, invalid_receipt: bool = False) -> str:
    try:
        receipt = json.loads(body)
    except (ValueError, RecursionError):
        receipt = None
    error = receipt.get("error") if isinstance(receipt, dict) else None
    code = error.get("code") if isinstance(error, dict) else None
    if not isinstance(code, str) or not re.fullmatch(r"[A-Z][A-Z0-9_]{0,79}", code):
        code = "NETWORK_ERROR" if status is None else "HTTP_ERROR"
    if status in (401, 403):
        state = "auth_blocked"
    elif (status is None or status in (408, 429) or 500 <= status <= 599
          or (status == 404 and code != "DELIVERY_TARGET_NOT_FOUND")
          or (status == 409 and code == "DELIVERY_TARGET_NOT_READY") or invalid_receipt):
        state = "retryable"
    else:
        state = "failed"
    if invalid_receipt:
        code = "INVALID_ATTACHMENT_RECEIPT"
    state = finish_attempt(path, profile, delivery_id, state, status, code, attempt_token=attempt_token)
    logger.warning("Hermes 移动端投递状态 %s（投递 ID %s，HTTP %s，错误码 %s）",
                   state, delivery_id, status, code)
    return state


def deliver_one(path: Path, endpoint: SplitResult, token: str, profile: str, delivery_id: str, text: str) -> str:
    attempt_token = begin_attempt(path, profile, delivery_id)
    if not attempt_token:
        return "queued"
    session_id, notice = delivery_target(path, delivery_id)
    references = []
    for reference, content in attachments(path, delivery_id):
        if not renew_attempt(path, profile, delivery_id, attempt_token):
            return "queued"
        payload = {"profile_ref": profile, **{key: reference[key] for key in ("name", "mime", "size")},
                   "content_base64": base64.b64encode(content).decode("ascii")}
        status, body = _request(endpoint, token, "PUT", f"/internal/attachments/v1/{reference['attachment_id']}", payload)
        if status not in (200, 201):
            return _failure(path, profile, delivery_id, status, body, attempt_token=attempt_token)
        try:
            receipt = json.loads(body)
        except (ValueError, RecursionError):
            receipt = None
        canonical = receipt.get("data") if isinstance(receipt, dict) else None
        mime = canonical.get("mime") if isinstance(canonical, dict) else None
        valid_mime = isinstance(mime, str) and (mime == reference["mime"]
            or mime in {"image/png", "image/jpeg", "image/gif", "image/webp"})
        if (not valid_mime or canonical != {**reference, "mime": mime}
                or type(canonical.get("size")) is not int):
            return _failure(path, profile, delivery_id, status, body,
                            attempt_token=attempt_token, invalid_receipt=True)
        references.append(canonical)
    if not renew_attempt(path, profile, delivery_id, attempt_token):
        return "queued"
    status, body = post_delivery(endpoint, token, delivery_id, profile, text, references, session_id=session_id, notice=notice)
    if status != 204:
        return _failure(path, profile, delivery_id, status, body, attempt_token=attempt_token)
    return "delivered" if ack(path, delivery_id, attempt_token=attempt_token) else "queued"


def deliver_pending(path: Path, endpoint: SplitResult, token: str, profile: str) -> bool:
    delivered = False
    for delivery_id, text in due(path, profile):
        state = deliver_one(path, endpoint, token, profile, delivery_id, text)
        delivered = delivered or state == "delivered"
        if state == "auth_blocked":
            break
    return delivered
