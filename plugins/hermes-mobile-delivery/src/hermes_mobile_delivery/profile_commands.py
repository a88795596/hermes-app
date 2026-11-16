"""Run profile-wide native handlers with the profile home fixed at import time."""

import asyncio
import os
from pathlib import Path


PROFILE_COMMANDS = frozenset({"personality", "memory", "skills", "insights"})

# Some original gateway handlers still import its process-level _hermes_home.
# An isolated native interpreter preserves those handlers without changing that
# global in the shared multi-profile gateway. API agents read this same config
# and on-disk memory/skills on their next turn.
NATIVE_SCRIPT = """
import asyncio
import os
import sys

name, text, session_id, profile, profile_home = sys.argv[1:]
os.environ["HERMES_HOME"] = profile_home

from gateway.config import Platform
from gateway.platforms.base import MessageEvent
from gateway.session import SessionSource
from gateway.slash_commands import GatewaySlashCommandsMixin

class NativeProfileContext(GatewaySlashCommandsMixin):
    def _session_key_for_source(self, source):
        return session_id

    def _evict_cached_agent(self, session_key):
        return None

    async def _run_in_executor_with_context(self, func, *args):
        return await asyncio.to_thread(func, *args)

context = NativeProfileContext()
event = MessageEvent(text=text, source=SessionSource(platform=Platform.API_SERVER,
    chat_id=session_id, chat_type="dm", user_id="mobile-api", profile=profile))
handler = getattr(context, "_handle_" + name + "_command")
result = asyncio.run(handler(event))
if not isinstance(result, str) or not result.strip():
    raise RuntimeError("Native command did not return text")
print(result)
"""


async def execute_profile_command(adapter, event, name):
    from .commands import failure, output_result
    import hermes_cli
    from hermes_cli._launchers import runtime_command
    from pm.environments import dependency_home_root, owning_home_root

    if name not in PROFILE_COMMANDS:
        return failure("此配置命令没有已注册的原生处理程序。")
    native_root = Path(hermes_cli.__file__).resolve().parent.parent
    runtime_home = owning_home_root(native_root) or dependency_home_root()
    command = runtime_command(native_root, (
        name, event.text, event.source.chat_id, adapter._command_profile, str(adapter._command_home),
    ), code=NATIVE_SCRIPT, home=runtime_home)
    env = dict(os.environ, HERMES_HOME=str(runtime_home))
    process = await asyncio.create_subprocess_exec(
        *command,
        cwd=str(native_root), env=env,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await process.communicate()
    if process.returncode:
        return failure("Hermes 原生配置命令未返回结果，请查询配置后确认。", unknown=True)
    return output_result(stdout.decode("utf-8").strip())
