"""Bridge the original /fast handler to API sessions and their next run."""

import asyncio
import json
import os
from pathlib import Path
import sys

from .spool import fast_selection


NATIVE_SCRIPT = """
import json
import os
import sys

home, model, current, command = sys.argv[1:]
os.environ["HERMES_HOME"] = home

from cli import HermesCLI
from gateway.run import GatewayRunner

class FastContext:
    _fast_command_available = HermesCLI._fast_command_available

    def __init__(self):
        self.model = model
        self.agent = None
        self._tier = json.loads(current)
        self.changed = False

    @property
    def service_tier(self):
        return self._tier

    @service_tier.setter
    def service_tier(self, value):
        self._tier = value
        self.changed = True

context = FastContext()
parts = command.split(maxsplit=1)
args, persist = GatewayRunner._parse_reasoning_command_args(parts[1] if len(parts) > 1 else "")
HermesCLI._handle_fast_command(context, "/fast " + (args or "status")
    + (" --global" if persist and args not in {"", "status"} else ""))
metadata = {}
if context.changed:
    metadata["fast_selection"] = (None if persist and GatewayRunner._load_service_tier() == context.service_tier
        else "priority" if context.service_tier == "priority" else "normal")
print(json.dumps(metadata))
"""


def runtime_tier(path, profile, session_id):
    from gateway.run import GatewayRunner

    selected = fast_selection(path, profile, session_id)
    if selected not in {None, "priority", "normal"}:
        raise ValueError("已保存的快速模式无效")
    return GatewayRunner._load_service_tier() if selected is None else "priority" if selected == "priority" else None


def register_fast_requests(ctx, adapters):
    if not callable(getattr(ctx, "register_middleware", None)):
        return False

    def before_request(*, request, session_id=None, platform=None, model=None, provider=None,
                       api_mode=None, base_url=None, **_kwargs):
        from gateway.config import Platform
        from hermes_constants import get_hermes_home
        from hermes_cli.models import resolve_fast_mode_overrides

        if platform != "api_server" or not isinstance(request, dict) or not session_id:
            return
        for adapter in tuple(adapters):
            if adapter._command_home != Path(get_hermes_home()).resolve():
                continue
            runner = getattr(adapter, "gateway_runner", None)
            api = getattr(runner, "adapters", {}).get(Platform("api_server"))
            for agent in tuple(getattr(api, "_active_run_agents", {}).values()):
                if getattr(agent, "session_id", None) != session_id or getattr(agent, "service_tier", None) != "priority":
                    continue
                database = getattr(getattr(agent, "_session_db", None), "db_path", None)
                if not database or Path(database).resolve().parent != adapter._command_home:
                    continue
                overrides = resolve_fast_mode_overrides(model, provider=provider, base_url=base_url)
                if not overrides:
                    return
                if api_mode == "anthropic_messages":
                    from agent.anthropic_adapter import build_anthropic_kwargs

                    native = build_anthropic_kwargs(model=model, messages=[], tools=None, max_tokens=None,
                        reasoning_config=None, fast_mode=True, is_oauth=getattr(agent, "_is_anthropic_oauth", False),
                        base_url=getattr(agent, "_anthropic_base_url", base_url),
                        drop_context_1m_beta=bool(getattr(agent, "_oauth_1m_beta_disabled", False)))
                    if native.get("extra_body", {}).get("speed") != "fast":
                        return
                    headers = {**request.get("extra_headers", {}), **native["extra_headers"]}
                    betas = [*request.get("extra_headers", {}).get("anthropic-beta", "").split(","),
                             *headers["anthropic-beta"].split(",")]
                    headers["anthropic-beta"] = ",".join(dict.fromkeys(beta for beta in betas if beta))
                    return {"request": {**request, "extra_headers": headers,
                        "extra_body": {**request.get("extra_body", {}), **native["extra_body"]}}}
                if api_mode in {"chat_completions", "codex_responses"} and "service_tier" in overrides:
                    return {"request": {**request, **overrides}}

    # Some native API factories keep service_tier on the agent without building provider kwargs.
    ctx.register_middleware("llm_request", before_request)
    return True


async def execute_fast_command(adapter, event, path, model=None):
    from .commands import failure, output_result
    from .session_commands import create_session_context
    from .compression import _api_runtime
    from gateway.platforms.api_server import _reserve_pending_api_work, _release_pending_api_work
    import hermes_cli

    try:
        context = await create_session_context(adapter, event)
        if context.busy:
            return failure("请等待当前回复完成后再切换快速模式。")
        if model is None:
            model, _ = await asyncio.to_thread(_api_runtime, context)
        tier = await asyncio.to_thread(runtime_tier, path, adapter._command_profile, event.source.chat_id)
    except Exception:
        return failure("无法读取当前 Hermes 会话的快速模式或模型。")
    native_root = Path(hermes_cli.__file__).resolve().parent.parent
    with _reserve_pending_api_work(context.api) as reservation:
        reservation["detached"] = True
        asyncio.current_task().add_done_callback(lambda _: _release_pending_api_work(context.api, reservation))
        process = await asyncio.create_subprocess_exec(sys.executable, "-c", NATIVE_SCRIPT,
            str(adapter._command_home), model, json.dumps(tier), event.text, cwd=str(native_root),
            env=dict(os.environ, HERMES_HOME=str(adapter._command_home)),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, _ = await process.communicate()
    if process.returncode:
        return failure("Hermes 未确认快速模式的执行结果，请查询原请求。", unknown=True)
    try:
        output, metadata = stdout.decode("utf-8").strip().rsplit("\n", 1)
        metadata = json.loads(metadata)
        if (not isinstance(metadata, dict) or set(metadata) - {"fast_selection"}
                or ("fast_selection" in metadata and metadata["fast_selection"] not in {None, "priority", "normal"})):
            raise ValueError("Invalid native fast result")
        return {**output_result(output.strip()), **metadata}
    except Exception:
        return failure("Hermes 快速模式回执无效，请查询原请求。", unknown=True)
