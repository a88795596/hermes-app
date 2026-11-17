"""Exercise native /fast in temporary profiles; never construct a model or use the network."""

import asyncio
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from uuid import uuid4
from unittest.mock import patch


def main():
    native_root = Path(sys.argv[1]).resolve()
    sys.path.insert(0, str(native_root))
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
    with TemporaryDirectory(prefix="hermes-native-fast-") as directory:
        root = Path(directory).resolve()
        default, work = root / "default", root / "work"
        for home in (default, work):
            home.mkdir()
            (home / "config.yaml").write_text("model:\n  default: gpt-6\nagent:\n  service_tier: normal\n")
        original = (default / "config.yaml").read_bytes()
        os.environ["HERMES_HOME"] = str(default)
        from gateway.config import Platform, PlatformConfig
        from gateway.platforms.api_server import APIServerAdapter
        from gateway.platforms.base import MessageEvent
        from gateway.session import SessionSource
        from hermes_constants import reset_hermes_home_override, set_hermes_home_override
        from hermes_mobile_delivery import fast_commands, spool
        from hermes_cli.middleware import apply_llm_request_middleware

        guard = """
import socket, sys
def deny_network(event, args):
    if event == "socket.connect" and args[0].family in {socket.AF_INET, socket.AF_INET6}:
        raise AssertionError("Native fast smoke must not access the network")
sys.addaudithook(deny_network)
"""

        async def run():
            token = set_hermes_home_override(work)
            api = APIServerAdapter(PlatformConfig(extra={}))
            try:
                db = await api._ensure_session_db_async()
                db.create_session("mobile_fast", "api_server", model="gpt-6")
                adapter = SimpleNamespace(_command_home=work, _command_profile="work",
                    gateway_runner=SimpleNamespace(adapters={Platform.API_SERVER: api}))
                path = work / "private" / "queue.sqlite3"
                source = SessionSource(platform=Platform.API_SERVER, chat_id="mobile_fast", profile="work")

                async def command(text, model="gpt-6"):
                    rid = str(uuid4())
                    spool.start_command(path, "work", rid, "mobile_fast", text)
                    result = await asyncio.create_task(fast_commands.execute_fast_command(adapter,
                        MessageEvent(text=text, source=source), path, model))
                    await asyncio.sleep(0)
                    assert result["ok"], result
                    kwargs = {"fast_selection": result.pop("fast_selection")} if "fast_selection" in result else {}
                    spool.finish_command(path, "work", rid, result, **kwargs)
                    assert spool.read_command(path, "work", rid, "mobile_fast") == result
                    return result

                with patch.object(fast_commands, "NATIVE_SCRIPT", guard + fast_commands.NATIVE_SCRIPT):
                    assert fast_commands.runtime_tier(path, "work", "mobile_fast") is None
                    await command("/fast on")
                    assert fast_commands.runtime_tier(path, "work", "mobile_fast") == "priority"
                    assert fast_commands.runtime_tier(path, "work", "other") is None
                    assert "fast" in (await command("/fast status"))["output"].lower()
                    await command("/fast off")
                    assert spool.fast_selection(path, "work", "mobile_fast") == "normal"
                    await command("/fast on --global")
                    assert spool.fast_selection(path, "work", "mobile_fast") is None
                    assert fast_commands.runtime_tier(path, "work", "other") == "priority"
                    await command("/fast off")
                    assert fast_commands.runtime_tier(path, "work", "mobile_fast") is None
                    assert fast_commands.runtime_tier(path, "work", "other") == "priority"
                    await command("/fast on", model="unsupported-model")
                    assert spool.fast_selection(path, "work", "mobile_fast") == "normal"
                    await command("/fast unknown")
                    assert spool.fast_selection(path, "work", "mobile_fast") == "normal"
                    assert (default / "config.yaml").read_bytes() == original
                    assert db._conn.execute("SELECT COUNT(*) FROM gateway_routing").fetchone()[0] == 0
                    assert db.get_messages("mobile_fast") == []
                middleware = {}
                fast_commands.register_fast_requests(SimpleNamespace(register_middleware=middleware.__setitem__), [adapter])
                agent = SimpleNamespace(session_id="mobile_fast", service_tier="priority", _is_anthropic_oauth=True, _session_db=db)
                api._active_run_agents = {"run_fast": agent}
                manager = SimpleNamespace(has_middleware=lambda kind: kind in middleware,
                    invoke_middleware=lambda kind, **kwargs: [middleware[kind](**kwargs)])
                original_request = {"model": "gpt-6", "messages": [{"role": "user", "content": "test"}]}
                def request(**overrides):
                    return apply_llm_request_middleware(original_request, **{
                        "platform": "api_server", "session_id": "mobile_fast", "model": "gpt-6",
                        "provider": "openai", "api_mode": "chat_completions", "base_url": "https://api.openai.com/v1",
                        **overrides}).payload
                with patch("hermes_cli.plugins.get_plugin_manager", return_value=manager):
                    assert request()["service_tier"] == "priority"
                    assert "service_tier" not in original_request
                    assert "service_tier" not in request(session_id="other")
                    assert "service_tier" not in request(platform="cli")
                    assert "service_tier" not in request(model="unsupported-model")
                    assert "service_tier" not in request(base_url="https://proxy.invalid/v1")
                    assert "service_tier" not in request(provider="other")
                    assert request(api_mode="codex_responses")["service_tier"] == "priority"
                    anthropic = request(model="claude-opus-4-8", provider="anthropic",
                        api_mode="anthropic_messages", base_url="https://api.anthropic.com")
                    assert anthropic["extra_body"]["speed"] == "fast"
                    assert "fast-mode-" in anthropic["extra_headers"]["anthropic-beta"]
                    assert "oauth-" in anthropic["extra_headers"]["anthropic-beta"]
                    assert "extra_body" not in request(model="claude-opus-4-8", api_mode="anthropic_messages",
                        base_url="https://example.invalid")
                    agent.service_tier = None
                    assert "service_tier" not in request()
                    agent.service_tier = "priority"
                    agent._session_db = SimpleNamespace(db_path=default / "state.db")
                    assert "service_tier" not in request()
                print("PASS: actual native request middleware emits priority/speed and preserves OAuth beta headers")
                print("PASS: native fast/on/off/status/global, explicit normal, model validation and profile isolation")
            finally:
                for db in getattr(api, "_session_dbs", {}).values():
                    db.close()
                reset_hermes_home_override(token)

        asyncio.run(run())


if __name__ == "__main__":
    main()
