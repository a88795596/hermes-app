"""Hermes 移动端收件箱投递 API 客户端。"""

from contextlib import closing
from http.client import HTTPConnection, HTTPException, HTTPSConnection
import json
import logging
from pathlib import Path
import re
from time import sleep
from urllib.parse import SplitResult, urlsplit

from .spool import ack, pull


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


def post_delivery(endpoint: SplitResult, token: str, delivery_id: str, profile: str, text: str) -> int | None:
    body = json.dumps({"delivery_id": delivery_id, "profile_ref": profile, "text": text},
                      ensure_ascii=False).encode("utf-8")
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    connect = HTTPSConnection if endpoint.scheme == "https" else HTTPConnection
    for attempt in range(3):
        if attempt:
            sleep(0.25 * attempt)
        try:
            with closing(connect(endpoint.hostname, endpoint.port, timeout=5)) as connection:
                connection.request("POST", endpoint.path or "/", body, headers)
                with connection.getresponse() as response:
                    status = response.status
        except (OSError, HTTPException, ValueError):
            status = None
        if status is not None and status not in (408, 429) and not 500 <= status <= 599:
            return status
    return status


def deliver_pending(path: Path, endpoint: SplitResult, token: str, profile: str) -> bool:
    pending = pull(path, profile)
    for delivery_id, text in pending:
        status = post_delivery(endpoint, token, delivery_id, profile, text)
        if status != 204:
            # shortcut: 按入队顺序暂停重试，确认单条故障需要独立处置时再引入隔离队列。
            logger.warning("Hermes 移动端投递等待重试（投递 ID %s，HTTP 状态 %s）", delivery_id, status)
            return False
        ack(path, delivery_id)
    return bool(pending)
