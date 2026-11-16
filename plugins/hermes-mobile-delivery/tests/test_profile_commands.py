from pathlib import Path
from types import ModuleType, SimpleNamespace
import sys
import unittest
from unittest.mock import AsyncMock, patch

from hermes_mobile_delivery.profile_commands import execute_profile_command


class ProfileCommandTest(unittest.IsolatedAsyncioTestCase):
    async def test_native_subprocess_uses_selected_home_and_literal_arguments(self):
        native = ModuleType("hermes_cli")
        native.__file__ = "/native/hermes/hermes_cli/__init__.py"
        native.__path__ = []
        launchers = ModuleType("hermes_cli._launchers")
        launchers.runtime_command = lambda root, args, *, code, home: ["runtime-python", "-I", "-c", code, *args]
        environments = ModuleType("pm.environments")
        environments.owning_home_root = lambda root: Path("/private/install")
        environments.dependency_home_root = lambda: Path("/private/fallback")
        commands = ModuleType("hermes_mobile_delivery.commands")
        commands.failure = lambda message, unknown=False: {"ok": False, "error": message}
        commands.output_result = lambda text: {"ok": True, "output": text}
        process = SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=("原生人格已保存\n".encode(), b"")))
        create = AsyncMock(return_value=process)
        adapter = SimpleNamespace(_command_home=Path("/private/profile/work"), _command_profile="work")
        event = SimpleNamespace(text="/personality careful; echo no-shell", source=SimpleNamespace(chat_id="mobile_session"))
        with patch.dict(sys.modules, {"hermes_cli": native, "hermes_cli._launchers": launchers,
                                      "pm.environments": environments, "hermes_mobile_delivery.commands": commands}), \
                patch("asyncio.create_subprocess_exec", create):
            result = await execute_profile_command(adapter, event, "personality")
        self.assertEqual(result, {"ok": True, "output": "原生人格已保存"})
        arguments = create.call_args
        self.assertEqual(arguments.args[:3], ("runtime-python", "-I", "-c"))
        self.assertIn(event.text, arguments.args)
        self.assertEqual(arguments.args[-1], "/private/profile/work")
        self.assertEqual(arguments.kwargs["env"]["HERMES_HOME"], "/private/install")
        self.assertEqual(arguments.kwargs["cwd"], "/native/hermes")
        self.assertNotIn("shell", arguments.kwargs)
