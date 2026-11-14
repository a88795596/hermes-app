"""Stage a document in the same scoped cache used by Telegram."""

import asyncio
import base64
import logging
import re

from aiohttp import web

logger = logging.getLogger(__name__)
_MAX_BYTES = 5 * 1024 * 1024


async def attachment_handler(adapter, request):
    auth_error = adapter._check_auth(request)
    if auth_error is not None:
        return auth_error
    try:
        body = await request.json()
        name = body.get("name") if isinstance(body, dict) else None
        encoded = body.get("content_base64") if isinstance(body, dict) else None
        if (not isinstance(name, str) or len(name.encode("utf-8")) > 200
                or not re.fullmatch(r"[\w. -]+", name) or name.strip(". ") != name
                or not isinstance(encoded, str) or len(encoded) > 4 * ((_MAX_BYTES + 2) // 3)):
            raise ValueError
        data = base64.b64decode(encoded, validate=True)
        if not 0 < len(data) <= _MAX_BYTES:
            raise ValueError
    except ValueError:
        return web.json_response({"error": "invalid_attachment"}, status=400)

    from gateway.platforms.base import cache_document_from_bytes
    from tools.credential_files import to_agent_visible_cache_path

    try:
        path = await asyncio.to_thread(cache_document_from_bytes, data, name)
        return web.json_response({"path": to_agent_visible_cache_path(path)})
    except (OSError, ValueError) as exc:
        logger.warning("Hermes Mobile document staging failed: %s", type(exc).__name__)
        return web.json_response({"error": "attachment_storage_unavailable"}, status=503)
