"""Opt-in smoke test against an unmodified local Hermes checkout.

Run with that checkout's Python:
    python tests/native_session_commands_smoke.py /path/to/hermes-agent

All state and Git changes live in a temporary directory. Network access is
blocked, account billing is mocked, and compression only uses --preview.
"""

import asyncio
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch


def main():
    native_root = Path(sys.argv[1]).resolve()
    sys.path.insert(0, str(native_root))
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
    with TemporaryDirectory(prefix="hermes-native-command-smoke-") as directory:
        root = Path(directory).resolve()
        default_home = root / "default"
        default_home.mkdir()
        os.environ["HERMES_HOME"] = str(default_home)

        def deny_network(event, args):
            if event == "socket.connect" and args[0].family in {socket.AF_INET, socket.AF_INET6}:
                raise AssertionError("Native command smoke must not access the network")

        sys.addaudithook(deny_network)
        from gateway.config import Platform, PlatformConfig
        from gateway.hooks import HookRegistry
        from gateway.platforms.api_server import APIServerAdapter
        from gateway.platforms.base import MessageEvent
        from gateway.run import GatewayRunner
        from gateway.session import SessionSource
        from hermes_constants import reset_hermes_home_override, set_hermes_home_override
        from hermes_mobile_delivery.compression import execute_compression
        from hermes_mobile_delivery.session_commands import create_session_context, execute_session_command

        api = APIServerAdapter(PlatformConfig(extra={"model_name": "gpt-4o"}))
        runner = object.__new__(GatewayRunner)
        runner.adapters = {Platform.API_SERVER: api}
        runner.hooks = HookRegistry()
        api.gateway_runner = runner
        adapter = SimpleNamespace(gateway_runner=runner)

        async def command(source, name, text=None, approval="once"):
            event = MessageEvent(text=text or f"/{name}", source=source,
                raw_message={"hermes_mobile_approval": approval})
            handler = execute_compression(adapter, event) if name == "compress" else execute_session_command(adapter, event, name)
            result = await asyncio.create_task(handler)
            await asyncio.sleep(0)  # release the command task's drain reservation
            assert result.get("ok"), (source.profile, name, result)
            assert api._pending_agent_requests == 0, (name, "reservation leaked")
            print(json.dumps({"profile": source.profile, "command": text or f"/{name}", **result}, ensure_ascii=False))
            return result

        async def run():
            databases = []
            for profile in ("default", "work"):
                home = default_home if profile == "default" else root / "profiles" / profile
                home.mkdir(parents=True, exist_ok=True)
                token = set_hermes_home_override(home)
                try:
                    db = await api._ensure_session_db_async()
                    databases.append(db)
                    assert Path(db.db_path).resolve() == home / "state.db"
                    sid = "mobile_shared"
                    source = SessionSource(platform=Platform.API_SERVER, chat_id=sid, profile=profile)
                    db.create_session(sid, "api_server", model="gpt-4o", profile_name=profile)
                    for index in range(3):
                        db.append_message(sid, "user", f"{profile} user {index}")
                        db.append_message(sid, "assistant", f"{profile} assistant {index}")
                    config_path = home / "config.yaml"
                    config_before = config_path.read_bytes() if config_path.exists() else None
                    messages_before = db.get_messages(sid, include_inactive=True)
                    for name in ("new", "undo"):
                        pending = await command(source, name, approval=None)
                        assert pending["native_result"] == {"confirmation": pending["output"]}
                        assert f"Confirm /{name}" in pending["output"]
                    assert db.get_messages(sid, include_inactive=True) == messages_before
                    assert db.get_session(sid).get("end_reason") is None
                    assert (config_path.read_bytes() if config_path.exists() else None) == config_before
                    for name in ("status", "context", "usage"):
                        await command(source, name)
                    title = await command(source, "title", f"/title {profile} 标题")
                    assert title["native_result"] == {"title": f"{profile} 标题"}
                    before = db.get_messages(sid, include_inactive=True)
                    preview = await command(source, "compress", "/compress here 1 --preview")
                    assert "native_result" not in preview
                    assert db.get_messages(sid, include_inactive=True) == before
                    undone = await command(source, "undo")
                    assert undone["native_result"] == {"rewound_turns": 1}
                    assert len(db.get_messages(sid)) == 4
                    assert len(db.get_messages(sid, include_inactive=True)) == 6

                    # Simulate the lineage written by native auto-compression,
                    # then keep addressing its old public HTTP session ID.
                    db.end_session(sid, "compression")
                    child = f"{sid}_continuation"
                    db.create_session(child, "api_server", parent_session_id=sid, model="gpt-4o")
                    for index in range(3):
                        db.append_message(child, "user", f"{profile} child {index}")
                        db.append_message(child, "assistant", f"{profile} child answer {index}")
                    assert db.resolve_resume_session_id(sid) == child
                    view = await create_session_context(adapter, MessageEvent(text="/status", source=source))
                    assert view.entry.session_id == child
                    for name in ("status", "context", "usage"):
                        result = await command(source, name)
                        assert "session_id" not in result.get("native_result", {})
                    child_title = await command(source, "title", f"/title {profile} 续链")
                    assert child_title["native_result"] == {"title": f"{profile} 续链"}
                    assert db.get_session_title(sid) == f"{profile} 标题"
                    child_before = db.get_messages(child, include_inactive=True)
                    await command(source, "compress", "/compress --preview")
                    assert db.get_messages(child, include_inactive=True) == child_before
                    undone = await command(source, "undo")
                    assert undone["native_result"] == {"rewound_turns": 1}
                    assert len(db.get_messages(child)) == 4
                    assert len(db.get_messages(sid)) == 4

                    runner._session_model_overrides[sid] = "temporary-model"
                    created = await command(source, "new", f"/new {profile} 新会话")
                    new_id = created["native_result"]["session_id"]
                    assert created["native_result"]["reset"] is True
                    assert db.get_session_title(new_id) == f"{profile} 新会话"
                    assert db.get_session(child)["end_reason"] == "session_reset"
                    assert db.get_messages(new_id) == []
                    assert sid not in runner._session_model_overrides
                    assert not (home / "sessions" / "sessions.json").exists()
                    assert db._conn.execute("SELECT COUNT(*) FROM gateway_routing").fetchone()[0] == 0
                    assert (config_path.read_bytes() if config_path.exists() else None) == config_before

                    if profile == "work":
                        from hermes_cli.config import load_config

                        default_config = default_home / "config.yaml"
                        default_before = default_config.read_bytes() if default_config.exists() else None
                        approval_sid = "mobile_confirmation"
                        db.create_session(approval_sid, "api_server", model="gpt-4o")
                        for index in range(2):
                            db.append_message(approval_sid, "user", f"approval user {index}")
                            db.append_message(approval_sid, "assistant", f"approval assistant {index}")
                        approval_source = SessionSource(platform=Platform.API_SERVER,
                            chat_id=approval_sid, profile=profile)
                        approved = await command(approval_source, "undo", approval="always")
                        assert approved["native_result"] == {"rewound_turns": 1}
                        assert load_config()["approvals"]["destructive_slash_confirm"] is False
                        assert (default_config.read_bytes() if default_config.exists() else None) == default_before
                        automatic = await command(approval_source, "undo", approval=None)
                        assert automatic["native_result"] == {"rewound_turns": 1}
                        assert db.get_messages(approval_sid) == []
                finally:
                    reset_hermes_home_override(token)

            assert databases[0] is not databases[1]
            assert databases[0].get_session_title("mobile_shared") == "default 标题"
            assert databases[1].get_session_title("mobile_shared") == "work 标题"
            # A stale pinned DB must fail before accessing the other profile.
            api._session_db = databases[1]
            source = SessionSource(platform=Platform.API_SERVER, chat_id="mobile_shared", profile="default")
            rejected = await execute_session_command(adapter, MessageEvent(text="/undo", source=source), "undo")
            assert not rejected["ok"] and "不匹配" in rejected["error"]
            api._session_db = None
            pending = await command(source, "undo", approval=None)
            assert "confirmation" in pending["native_result"], "Work profile opt-out leaked into default"

            worktree = root / "diff"
            worktree.mkdir()
            subprocess.run(["git", "init", "--quiet", str(worktree)], check=True)
            document = worktree / "example.txt"
            document.write_text("before\n")
            subprocess.run(["git", "-C", str(worktree), "add", "example.txt"], check=True)
            document.write_text("after\n")
            with patch.dict(os.environ, {"TERMINAL_CWD": str(worktree)}):
                diff = await command(source, "diff")
                assert "```diff" in diff["output"] and "+after" in diff["output"]
            for db in databases:
                db.close()
            print("PASS: native session commands, real profile DB routing, compression lineage, read-only preview, diff descriptors, zero gateway routes, native confirmation and isolated always approval")

        # Block all provider requests; these two format-only boundaries are
        # unrelated to the session handler/store behavior exercised above.
        with patch("gateway.slash_commands.fetch_account_usage", return_value=None), \
                patch("agent.account_usage.nous_credits_lines", return_value=[]), \
                patch.object(runner, "_reset_notice_session_info", return_value=""), \
                patch.object(api, "_create_agent", side_effect=AssertionError("Preview must not construct an agent")):
            asyncio.run(run())


if __name__ == "__main__":
    main()
