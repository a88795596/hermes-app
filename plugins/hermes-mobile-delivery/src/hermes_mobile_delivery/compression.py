"""Use Hermes' manual compressor against the existing API session."""

import asyncio
import builtins
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from types import FunctionType, SimpleNamespace


class ScopedExecutor(ThreadPoolExecutor):
    def submit(self, fn, /, *args, **kwargs):
        # Native compression and insights use run_in_executor; preserve the
        # authenticated profile scope through those worker hops as well.
        return super().submit(copy_context().run, fn, *args, **kwargs)


def _capture_agent_arguments(api, **kwargs):
    """Evaluate the native factory with an isolated, inert constructor.

    Keep native model/provider precedence and credential resolution verbatim.
    The copied callable has its own builtins/import binding; no shared module,
    class, function globals or original factory are patched. A normal AIAgent
    must never be constructed here: initialization touches memory providers and
    close() tears down resources belonging to the live session.
    """
    original = api._create_agent
    function = getattr(original, "__func__", None)
    if (not isinstance(function, FunctionType) or getattr(original, "__self__", None) is not api
            or not {"run_agent", "AIAgent"}.issubset(function.__code__.co_names)):
        raise RuntimeError("Hermes API runtime factory is not compatible with argument capture")

    class Arguments(SimpleNamespace):
        def __init__(self, **arguments):
            super().__init__(**arguments)
            self.arguments = arguments

    native_builtins = function.__globals__.get("__builtins__", builtins)
    isolated_builtins = dict(native_builtins if isinstance(native_builtins, dict) else vars(native_builtins))
    native_import = isolated_builtins["__import__"]

    def import_for_factory(name, globals=None, locals=None, fromlist=(), level=0):
        if name == "run_agent" and "AIAgent" in fromlist and level == 0:
            return SimpleNamespace(AIAgent=Arguments)
        return native_import(name, globals, locals, fromlist, level)

    isolated_builtins["__import__"] = import_for_factory
    isolated_globals = {**function.__globals__, "__builtins__": isolated_builtins}
    factory = FunctionType(function.__code__, isolated_globals, function.__name__,
                           function.__defaults__, function.__closure__)
    factory.__kwdefaults__ = function.__kwdefaults__
    captured = factory(api, **kwargs)
    if not isinstance(captured, Arguments):
        raise RuntimeError("Hermes API runtime factory did not return captured arguments")
    return captured.arguments


def _api_runtime(context):
    """Let the API adapter resolve its own persisted model lock and credentials."""
    api, row = context.api, context.row
    request = api._effective_session_runtime_request(session=row, body={})
    locked = bool(request.get("require_model_lock"))
    requested = request.get("requested") or {}
    stored_model = row.get("model")
    route = request.get("route") if locked else api._resolve_route(stored_model)
    arguments = _capture_agent_arguments(api,
        session_id=context.entry.session_id,
        gateway_session_key=context.entry.session_key,
        route=route,
        session_model=stored_model if not locked and not route else None,
        requested_model=requested.get("model") if locked else None,
        requested_provider=requested.get("provider") if locked else None,
        model_options=request.get("model_options") if locked else None,
        confirmed_runtime_lock=locked,
    )
    runtime = {key: arguments[key] for key in
               ("provider", "requested_provider", "api_key", "base_url", "api_mode",
                "command", "args", "max_tokens", "credential_pool")
               if arguments.get(key) is not None}
    return arguments["model"], runtime


def _run_native_handler(context):
    loop = asyncio.new_event_loop()
    loop.set_default_executor(ScopedExecutor(max_workers=4))
    try:
        return loop.run_until_complete(context._handle_compress_command(context.event))
    finally:
        loop.run_until_complete(loop.shutdown_asyncgens())
        loop.run_until_complete(loop.shutdown_default_executor())
        loop.close()


async def execute_compression(adapter, event):
    from gateway.platforms.api_server import _reserve_pending_api_work, _release_pending_api_work
    from .commands import failure, output_result
    from .session_commands import create_session_context

    try:
        context = await create_session_context(adapter, event)
        context.require_idle()
    except Exception as error:
        return failure(str(error) if isinstance(error, ValueError) else "无法读取当前 Hermes 会话。")
    # Read-only previews retain the native early-return path and do not create
    # a provider agent. The resolver runs only if the original handler needs it.
    context._resolve_session_agent_runtime = lambda **kwargs: _api_runtime(context)
    original_tip = context.entry.session_id
    try:
        # This native reservation makes the detached helper visible to the
        # gateway's graceful restart drain until execute_and_save has also
        # persisted the final receipt (the enclosing task owns that write).
        with _reserve_pending_api_work(context.api) as reservation:
            reservation["detached"] = True
            asyncio.current_task().add_done_callback(
                lambda completed: _release_pending_api_work(context.api, reservation))
            text = await asyncio.to_thread(_run_native_handler, context)
        result = output_result(text)
        if context.entry.session_id != original_tip:
            result["native_result"] = {"session_id": context.entry.session_id}
        return result
    except Exception:
        return failure("无法确认 Hermes 压缩结果，请查询原请求回执。", unknown=True)
