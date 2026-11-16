"""Opt-in native profile handler smoke; all writes are confined to temporary homes."""

import asyncio
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch


def main():
    native_root = Path(sys.argv[1]).resolve()
    sys.path.insert(0, str(native_root))
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
    with TemporaryDirectory(prefix="hermes-native-profile-smoke-") as directory:
        root = Path(directory).resolve()
        default, work = root / "default", root / "work"
        default.mkdir()
        work.mkdir()
        original = "agent:\n  system_prompt: default-profile-unchanged\n"
        (default / "config.yaml").write_text(original)
        (work / "config.yaml").write_text(
            "agent:\n  personalities:\n    careful: 'Work profile native personality'\n")
        os.environ["HERMES_HOME"] = str(default)
        os.environ.pop("HERMES_EPHEMERAL_SYSTEM_PROMPT", None)
        from gateway.config import Platform
        from gateway.platforms.base import MessageEvent
        from gateway.run import GatewayRunner
        from gateway.session import SessionSource
        from hermes_constants import reset_hermes_home_override, set_hermes_home_override
        from hermes_mobile_delivery import profile_commands

        adapter = SimpleNamespace(_command_home=work, _command_profile="work")
        source = SessionSource(platform=Platform.API_SERVER, chat_id="mobile_native_smoke", profile="work")
        network_guard = """
import socket
import sys
def reject_network(event, args):
    if event == "socket.connect" and args[0].family in {socket.AF_INET, socket.AF_INET6}:
        raise AssertionError("Native profile smoke must not access the network")
sys.addaudithook(reject_network)
"""

        async def run():
            token = set_hermes_home_override(work)
            try:
                with patch.object(profile_commands, "NATIVE_SCRIPT", network_guard + profile_commands.NATIVE_SCRIPT):
                    result = await profile_commands.execute_profile_command(adapter,
                        MessageEvent(text="/personality careful", source=source), "personality")
                    assert result.get("ok"), result
                    assert "careful" in result["output"], result
                    assert GatewayRunner._load_ephemeral_system_prompt() == "Work profile native personality"
                    assert (default / "config.yaml").read_text() == original
                    for name, args in (("memory", "pending"), ("skills", "pending"), ("insights", "7")):
                        result = await profile_commands.execute_profile_command(adapter,
                            MessageEvent(text=f"/{name} {args}", source=source), name)
                        assert result.get("ok"), (name, result)
                        assert result["output"].strip(), name
            finally:
                reset_hermes_home_override(token)
            print("PASS: native personality, memory, skills, insights; work profile isolated and runtime prompt refreshed")

        asyncio.run(run())


if __name__ == "__main__":
    main()
