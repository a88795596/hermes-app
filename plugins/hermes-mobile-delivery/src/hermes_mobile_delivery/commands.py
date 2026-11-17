"""原生命令目录与网关控制，不接管 API 会话的运行状态。"""

import asyncio
import json
from pathlib import Path
import re
from uuid import UUID

from .spool import finish_command, read_command, start_command
from .session_commands import SESSION_COMMANDS as NATIVE_SESSION_COMMANDS
from .profile_commands import PROFILE_COMMANDS


FORMATTERS = frozenset({"help", "commands", "version", "profile", "bundles"})
SESSION_COMMANDS = NATIVE_SESSION_COMMANDS | {"compress", "fast"}
SUPPORTED = FORMATTERS | SESSION_COMMANDS | PROFILE_COMMANDS | {"restart"}
REPLY_TIMEOUT = 10
MAX_OUTPUT_BYTES = 128 * 1024
SESSION_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,511}")
COMMAND = re.compile(r"/[a-z0-9][a-z0-9_-]{0,127}(?:[ \t]+.*)?", re.IGNORECASE | re.ASCII)


def failure(message, *, unknown=False):
    return {"ok": False, "status": "unknown" if unknown else "error", "error": message}


def output_result(text):
    from agent.redact import redact_sensitive_text

    if not isinstance(text, str) or not text.strip():
        raise ValueError("Hermes 未返回命令结果。")
    output = redact_sensitive_text(text, force=True, redact_url_credentials=True)
    if len(output.encode("utf-8")) > MAX_OUTPUT_BYTES or "\x00" in output:
        raise ValueError("Hermes 命令结果超过可接收的大小或格式无效。")
    return {"ok": True, "output": output}


def catalog(fast_supported):
    from hermes_cli.commands import COMMAND_REGISTRY, _is_gateway_available

    supported = SUPPORTED if fast_supported else SUPPORTED - {"fast"}
    return {"commands": [
        {"name": cmd.name, "description": cmd.description, "category": cmd.category,
         "aliases": list(cmd.aliases), **({"args_hint": cmd.args_hint} if cmd.args_hint else {}),
         **({"subcommands": list(cmd.subcommands)} if getattr(cmd, "subcommands", ()) else {}),
         "supported": cmd.name in supported,
         **({"unavailable_reason": "当前连接方式暂不支持此原生命令。"} if cmd.name not in supported else {})}
        for cmd in COMMAND_REGISTRY if _is_gateway_available(cmd)
    ]}


async def capture_reply(adapter, chat_id, reply_to, text):
    pending = adapter._command_replies.get((chat_id, reply_to))
    if pending is None:
        return False
    profile, path, future = pending
    try:
        result = output_result(text)
        await asyncio.to_thread(finish_command, path, profile, reply_to, result)
    except Exception:
        result = failure("Hermes 已回复，但无法确认命令回执是否保存，请勿重复执行。", unknown=True)
    if not future.done():
        future.set_result(result)
    return True


async def command_hook_result(adapter, event, name):
    hooks = getattr(getattr(adapter.gateway_runner, "hooks", None), "emit_collect", None)
    if not callable(hooks):
        return None
    raw_command = event.text.split(maxsplit=1)[0][1:].lower()
    raw_args = event.text.split(maxsplit=1)[1].strip() if len(event.text.split(maxsplit=1)) > 1 else ""
    platform = getattr(event.source.platform, "value", event.source.platform)
    try:
        results = await hooks(f"command:{name}", {"platform": platform, "user_id": event.source.user_id,
            "command": name, "raw_command": raw_command, "args": raw_args, "raw_args": raw_args})
    except Exception:
        # This is also the original gateway hook dispatch failure behavior.
        return None
    for result in results:
        if not isinstance(result, dict):
            continue
        decision = str(result.get("decision", "")).strip().lower()
        if decision == "deny":
            return failure(str(result.get("message") or f"Command `/{name}` was blocked by a hook."))
        if decision == "handled":
            message = result.get("message")
            return output_result(message) if isinstance(message, str) and message.strip() else failure(
                "Hermes 命令钩子已接管请求，但未提供结果，请勿重复执行。", unknown=True)
        if decision == "rewrite":
            from hermes_cli.commands import resolve_command

            target = str(result.get("command_name", "")).strip().lstrip("/")
            resolved = resolve_command(target)
            if resolved is None or resolved.name != name:
                return failure(f"Hermes 命令钩子要求改用 /{target}，请单独提交该命令。")
            text = f"/{resolved.name} {str(result.get('raw_args', '')).strip()}".strip()
            if (not COMMAND.fullmatch(text) or len(text.encode("utf-8")) > 8 * 1024
                    or any((ord(char) < 32 and char != "\t") or ord(char) == 127
                           or char in "\u0085\u2028\u2029" for char in text)):
                return failure("Hermes 命令钩子返回了无效的命令参数。")
            event.text = text
            break
    return None


async def dispatch(adapter, payload, configured):
    from hermes_constants import get_hermes_home

    if (not isinstance(payload, dict) or not configured
            or payload.get("profile_ref") != adapter._command_profile
            or configured[0] != adapter._command_profile
            or Path(get_hermes_home()).resolve() != adapter._command_home):
        return failure("命令请求与当前 Hermes 配置档案不匹配。")
    kind = payload.get("kind")
    allowed = {"kind", "profile_ref"} if kind == "catalog" else {
        "kind", "profile_ref", "request_id", "session_id"} | ({"command", "approval", "model"} if kind == "execute" else set())
    if kind == "runtime":
        allowed = {"kind", "profile_ref", "session_id"}
    if set(payload) - allowed or kind not in {"catalog", "execute", "result", "runtime"}:
        return failure("命令请求包含不支持的字段或操作。")
    if kind == "catalog":
        try:
            return catalog(adapter._fast_requests_supported)
        except Exception:
            return failure("无法读取 Hermes 原生命令目录。")

    if kind == "runtime":
        from gateway.run import GatewayRunner

        if "session_id" in payload and (not isinstance(payload["session_id"], str)
                or not SESSION_ID.fullmatch(payload["session_id"])):
            return failure("会话编号无效。")
        try:
            prompt = await asyncio.to_thread(GatewayRunner._load_ephemeral_system_prompt)
            if not isinstance(prompt, str) or len(prompt.encode("utf-8")) > MAX_OUTPUT_BYTES or "\x00" in prompt:
                return failure("Hermes 原生系统提示格式无效。")
            from .fast_commands import runtime_tier
            tier = await asyncio.to_thread(runtime_tier, configured[4], configured[0], payload.get("session_id", ""))
            if tier == "priority" and not adapter._fast_requests_supported:
                return failure("当前 Hermes 版本未提供快速模式所需的请求中间件。")
            return {"system_prompt": prompt, "service_tier": tier}
        except Exception:
            return failure("无法读取 Hermes 当前会话的运行配置。")

    if kind == "result":
        try:
            request_id, session_id = payload.get("request_id"), payload.get("session_id")
            if (not isinstance(request_id, str) or str(UUID(request_id)) != request_id
                    or not isinstance(session_id, str) or not SESSION_ID.fullmatch(session_id)):
                return failure("请求编号或会话编号无效。")
            result = await asyncio.to_thread(read_command, configured[4], configured[0], request_id, session_id)
            if result is None:
                return failure("尚未找到命令回执，原请求可能仍在登记，请继续查询原请求。", unknown=True)
            return result
        except Exception:
            return failure("无法查询命令回执，请保留原请求编号。", unknown=True)

    from hermes_cli.commands import _is_gateway_available, resolve_command
    from gateway.session import SessionSource

    command, request_id, session_id = (payload.get(key) for key in ("command", "request_id", "session_id"))
    approval = payload.get("approval")
    model = payload.get("model")
    try:
        if (not isinstance(command, str) or not COMMAND.fullmatch(command)
                or len(command.encode("utf-8")) > 8 * 1024
                or any((ord(char) < 32 and char != "\t") or ord(char) == 127 or char in "\u0085\u2028\u2029" for char in command)
                or not isinstance(request_id, str) or str(UUID(request_id)) != request_id
                or not isinstance(session_id, str) or not SESSION_ID.fullmatch(session_id)
                or ("approval" in payload and approval not in {"once", "always"})):
            return failure("命令、请求编号或会话编号无效。")
        pieces = command.strip().split(maxsplit=1)
        definition = resolve_command(pieces[0][1:])
        if not definition or not _is_gateway_available(definition) or definition.name not in SUPPORTED:
            return failure("当前连接方式不支持执行此原生命令。")
        if definition.name == "fast" and not adapter._fast_requests_supported:
            return failure("当前 Hermes 版本未提供快速模式所需的请求中间件。")
        if "model" in payload and (definition.name != "fast" or not isinstance(model, str) or not model.strip()
                or len(model.encode("utf-8")) > 512 or any(ord(char) < 32 or ord(char) == 127 for char in model)):
            return failure("快速模式的会话模型无效。")
        source = SessionSource(platform=adapter.platform, chat_id=session_id, chat_type="dm",
            user_id="mobile-api", user_name="Hermes 移动端", profile=adapter._command_profile, message_id=request_id)
        check = getattr(getattr(adapter, "gateway_runner", None), "_check_slash_access", None)
        if not callable(check):
            return failure("Hermes 未提供原生命令权限检查，无法执行命令。")
        if (denied := check(source, definition.name)) is not None:
            return failure(str(denied))
        if definition.name == "restart" and not getattr(adapter, "_message_handler", None):
            return failure("Hermes 网关尚未连接，无法执行重启命令。")
        if (definition.name in {"undo", "compress", "new", "fast"}
                and any(current_session == session_id and not task.done()
                        for current_session, task in adapter._command_tasks.values())):
            return failure("当前会话仍在处理原生命令，请等待原请求完成。")
        if len(adapter._command_replies) + len(adapter._command_tasks) >= 16:
            return failure("Hermes 正在处理其他命令，请稍后重试。")
        profile, _, _, _, path = configured
        fingerprint = command if approval is None else json.dumps([command, approval], ensure_ascii=False)
        if model is not None:
            fingerprint = json.dumps([command, approval, model], ensure_ascii=False)
        claimed, prior = await asyncio.to_thread(start_command, path, profile, request_id, session_id, fingerprint)
        if not claimed:
            return prior
    except (ValueError, UnicodeError):
        return failure("命令请求无效，或请求编号已用于另一条命令。")
    except Exception:
        return failure("无法安全保存命令请求，尚未执行。")

    if definition.name in FORMATTERS:
        from hermes_cli.slash_exec import CommandContext, execute_command

        try:
            reply = await asyncio.to_thread(execute_command, definition.name, CommandContext(surface="gateway",
                args=pieces[1] if len(pieces) > 1 else "", options={"profile_name": profile,
                    "home_display": str(adapter._command_home)}))
            result = output_result(reply.text)
        except Exception:
            result = failure("无法读取 Hermes 原生命令结果。")
        try:
            await asyncio.to_thread(finish_command, path, profile, request_id, result)
        except Exception:
            return failure("无法确认命令回执是否保存，请勿重复执行。", unknown=True)
        return result

    from gateway.platforms.base import MessageEvent

    event = MessageEvent(text=command, source=source, message_id=request_id,
        platform_update_id=UUID(request_id).int, internal=False,
        raw_message={"hermes_mobile_approval": approval})
    if definition.name in SESSION_COMMANDS | PROFILE_COMMANDS:
        async def execute_and_save():
            try:
                intercepted = await command_hook_result(adapter, event, definition.name)
                if intercepted is not None:
                    result = intercepted
                elif definition.name == "fast":
                    from .fast_commands import execute_fast_command
                    result = await execute_fast_command(adapter, event, path, model)
                elif definition.name == "compress":
                    from .compression import execute_compression
                    result = await execute_compression(adapter, event)
                elif definition.name in SESSION_COMMANDS:
                    from .session_commands import execute_session_command
                    result = await execute_session_command(adapter, event, definition.name)
                else:
                    from gateway.config import Platform
                    from gateway.platforms.api_server import _reserve_pending_api_work, _release_pending_api_work
                    from .profile_commands import execute_profile_command
                    api = adapter.gateway_runner.adapters[Platform("api_server")]
                    with _reserve_pending_api_work(api) as reservation:
                        reservation["detached"] = True
                        asyncio.current_task().add_done_callback(
                            lambda completed: _release_pending_api_work(api, reservation))
                        result = await execute_profile_command(adapter, event, definition.name)
            except Exception:
                result = failure("无法确认 Hermes 命令结果，请查询原请求回执。", unknown=True)
            try:
                selection = {"fast_selection": result.pop("fast_selection")} if definition.name == "fast" and "fast_selection" in result else {}
                await asyncio.to_thread(finish_command, path, profile, request_id, result, **selection)
            except Exception:
                return failure("无法保存 Hermes 命令回执，请勿重新执行。", unknown=True)
            return result

        task = asyncio.create_task(execute_and_save())
        adapter._command_tasks[request_id] = (session_id, task)
        task.add_done_callback(lambda completed: adapter._command_tasks.pop(request_id, None))
        try:
            return await asyncio.wait_for(asyncio.shield(task), REPLY_TIMEOUT)
        except asyncio.TimeoutError:
            return failure("Hermes 仍在处理命令，请查询原请求回执。", unknown=True)

    key = (session_id, request_id)
    future = asyncio.get_running_loop().create_future()
    adapter._command_replies[key] = (profile, path, future)
    try:
        await adapter.handle_message(event)
        return await asyncio.wait_for(asyncio.shield(future), REPLY_TIMEOUT)
    except Exception:
        return failure("无法确认 Hermes 是否已执行命令，请勿重复执行。", unknown=True)
    finally:
        adapter._command_replies.pop(key, None)
