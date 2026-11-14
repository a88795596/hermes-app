"""Expose Hermes' stateless title model through the HTTP Runs listener."""

import asyncio
import logging

from aiohttp import web

logger = logging.getLogger(__name__)
_slots = asyncio.Semaphore(4)


def _valid(value, limit):
    try:
        return (isinstance(value, str) and bool(value.strip()) and "\x00" not in value
                and len(value.encode("utf-8")) <= limit)
    except UnicodeEncodeError:
        return False


async def title_handler(adapter, request):
    auth_error = adapter._check_auth(request)
    if auth_error is not None:
        return auth_error
    try:
        body = await request.json()
    except ValueError:
        body = None
    if (not isinstance(body, dict) or not _valid(body.get("input"), 32 * 1024)
            or not _valid(body.get("instructions"), 1024)):
        return web.json_response({"error": "invalid_title_request"}, status=400)
    if _slots.locked():
        return web.json_response({"error": "title_model_busy"}, status=429)
    try:
        from agent.oneshot import run_oneshot

        async with _slots:
            title = await asyncio.to_thread(
                run_oneshot, task="title_generation", instructions=body["instructions"],
                user_input=body["input"], max_tokens=128, timeout=30,
            )
        if not _valid(title, 4096):
            return web.json_response({"error": "empty_title"}, status=502)
        return web.json_response({"text": title})
    except Exception as exc:
        logger.warning("Hermes Mobile title generation failed: %s", type(exc).__name__)
        return web.json_response({"error": "title_model_failed"}, status=502)
