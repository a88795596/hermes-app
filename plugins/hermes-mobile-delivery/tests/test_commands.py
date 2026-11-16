import asyncio
import importlib
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
from uuid import uuid4


class CommandTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.home = Path(directory.name)
        self.current_home = self.home
        self.registry = [self.command(name, aliases=("v",) if name == "version" else ())
                         for name in ("help", "commands", "version", "profile", "bundles", "restart", "goal", "undo")]
        self.registry.append(self.command("clear", cli_only=True))
        self.formatted = []
        self.events = []
        self.native_output = "正在等待现有任务结束后重启。"
        self.session_calls = []
        self.session_gate = None
        self.denied = None
        self.api_key = "native-api-key-at-least-sixteen"
        self.runtime_prompt = "原生人格"

        case = self

        class Base:
            def __init__(self, config, platform):
                self.config, self.platform = config, platform
                self._message_handler = object()

            async def handle_message(self, event):
                case.events.append(event)
                if case.native_output is not None:
                    async def reply():
                        await asyncio.sleep(0)
                        await self.send(event.source.chat_id, case.native_output, reply_to=event.message_id)
                    asyncio.create_task(reply())

        def resolve(name):
            name = name.lstrip("/").lower()
            return next((cmd for cmd in self.registry if name == cmd.name or name in cmd.aliases), None)

        def execute(name, context):
            self.formatted.append((name, context))
            return SimpleNamespace(text=f"原生 /{name} {context.args}".strip())

        async def execute_session(adapter, event, name):
            self.session_calls.append((event, name))
            if self.session_gate is not None:
                await self.session_gate.wait()
            return {"ok": True, "output": "原生撤回", "native_result": {"rewound_turns": 1}}

        exports = {
            "agent.redact": {"redact_sensitive_text": lambda text, **kwargs: text},
            "gateway.config": {"Platform": str},
            "gateway.session": {"SessionSource": SimpleNamespace},
            "gateway.run": {"GatewayRunner": SimpleNamespace(_load_ephemeral_system_prompt=lambda: self.runtime_prompt)},
            "gateway.platform_registry": {"PlatformEntry": SimpleNamespace(__dataclass_fields__={})},
            "gateway.platforms.base": {"BasePlatformAdapter": Base, "SendResult": SimpleNamespace,
                                       "MessageEvent": SimpleNamespace},
            "hermes_cli.config": {"get_env_value_prefer_dotenv": os.environ.get},
            "hermes_constants": {"get_hermes_home": lambda: self.current_home},
            "hermes_cli.commands": {"COMMAND_REGISTRY": self.registry, "resolve_command": resolve,
                                    "_is_gateway_available": lambda cmd: not cmd.cli_only},
            "hermes_cli.slash_exec": {"CommandContext": SimpleNamespace, "execute_command": execute},
            "hermes_mobile_delivery.session_commands": {"execute_session_command": execute_session,
                                                        "SESSION_COMMANDS": frozenset({"undo"})},
        }
        modules = {}
        for name, values in exports.items():
            module = ModuleType(name)
            module.__dict__.update(values)
            modules[name] = module
        mocking = patch.dict(sys.modules, modules)
        mocking.start()
        self.addCleanup(mocking.stop)
        environment = patch.dict(os.environ, {
            "HERMES_MOBILE_HOME_CHANNEL": "1", "HERMES_MOBILE_PROFILE": "default",
            "HERMES_MOBILE_INBOX_URL": "http://127.0.0.1:1/internal/inbox/v1/deliveries",
            "HERMES_MOBILE_INBOX_TOKEN": "inbox-token", "HERMES_MOBILE_SPOOL_PATH": str(self.home / "queue.sqlite3"),
            "API_SERVER_KEY": "wrong-environment-key",
        })
        environment.start()
        self.addCleanup(environment.stop)
        sys.modules.pop("hermes_mobile_delivery.adapter", None)
        self.addCleanup(sys.modules.pop, "hermes_mobile_delivery.adapter", None)
        self.module = importlib.import_module("hermes_mobile_delivery.adapter")
        self.platform = {}
        self.module.register_platform(SimpleNamespace(profile_name="default",
            register_platform=lambda **kwargs: self.platform.update(kwargs), register_cli_command=lambda **kwargs: None))
        self.adapter = self.make_adapter()

    @staticmethod
    def command(name, aliases=(), cli_only=False):
        return SimpleNamespace(name=name, description=f"Native {name}", category="Session", aliases=aliases,
                               args_hint="[args]", subcommands=("show", "clear"), cli_only=cli_only)

    def make_adapter(self):
        adapter = self.platform["adapter_factory"](SimpleNamespace(extra={}))
        adapter.gateway_runner = SimpleNamespace(adapters={"api_server": SimpleNamespace(_expected_api_key=lambda: self.api_key)},
            _check_slash_access=lambda source, name: self.denied)
        return adapter

    def payload(self, command="/restart", **overrides):
        return {"kind": "execute", "profile_ref": "default", "request_id": str(uuid4()),
                "session_id": "mobile_session", "command": command, **overrides}

    async def test_auth_uses_native_resolved_key_and_fails_closed(self):
        for header, expected in [(f"Bearer {self.api_key}", True), ("Bearer wrong-environment-key", False), ("", False)]:
            ok, _ = self.adapter.verify_http_event_request(header)
            self.assertEqual(ok, expected)
        self.api_key = ""
        self.assertFalse(self.adapter.verify_http_event_request("Bearer ")[0])

    async def test_catalog_tracks_native_registry_and_profile_home(self):
        data = await self.adapter.dispatch_http_event({"kind": "catalog", "profile_ref": "default"})
        commands = {cmd["name"]: cmd for cmd in data["commands"]}
        self.assertEqual(commands["version"]["aliases"], ["v"])
        self.assertEqual(commands["version"]["subcommands"], ["show", "clear"])
        self.assertTrue(commands["restart"]["supported"])
        self.assertFalse(commands["goal"]["supported"])
        self.assertNotIn("clear", commands)
        self.registry.append(self.command("future-native-command"))
        updated = await self.adapter.dispatch_http_event({"kind": "catalog", "profile_ref": "default"})
        self.assertIn("future-native-command", [cmd["name"] for cmd in updated["commands"]])
        self.current_home = self.home / "other"
        self.assertFalse((await self.adapter.dispatch_http_event({"kind": "catalog", "profile_ref": "default"}))["ok"])

    async def test_runtime_reads_current_native_prompt_on_each_request(self):
        request = {"kind": "runtime", "profile_ref": "default", "session_id": "mobile_session"}
        self.assertEqual(await self.adapter.dispatch_http_event(request), {"system_prompt": "原生人格"})
        self.runtime_prompt = ""
        self.assertEqual(await self.adapter.dispatch_http_event(request), {"system_prompt": ""})
        self.assertEqual((await self.adapter.dispatch_http_event({**request, "profile_ref": "other"}))["status"], "error")

    async def test_formatter_keeps_native_alias_arguments_and_result(self):
        request = self.payload("/v")
        self.assertEqual(await self.adapter.dispatch_http_event(request), {"ok": True, "output": "原生 /version"})
        self.assertEqual((await self.adapter.dispatch_http_event(self.payload("/commands 2")))["output"], "原生 /commands 2")
        self.assertEqual(self.formatted[1][1].surface, "gateway")
        self.assertEqual((await self.adapter.dispatch_http_event(self.payload("/V MixedCase")))["output"], "原生 /version MixedCase")
        self.assertEqual(self.events, [])

    async def test_native_hooks_deny_or_handle_without_calling_session_handler(self):
        self.adapter.gateway_runner.hooks = SimpleNamespace(emit_collect=AsyncMock(return_value=[
            {"decision": "deny", "message": "原生策略拒绝"}]))
        self.assertEqual((await self.adapter.dispatch_http_event(self.payload("/undo")))["error"], "原生策略拒绝")
        self.assertEqual(self.session_calls, [])
        self.adapter.gateway_runner.hooks.emit_collect.return_value = [{"decision": "handled", "message": "钩子原生结果"}]
        self.assertEqual((await self.adapter.dispatch_http_event(self.payload("/undo")))["output"], "钩子原生结果")
        self.assertEqual(self.session_calls, [])
        self.adapter.gateway_runner.hooks.emit_collect.return_value = [{"decision": "rewrite", "command_name": "restart"}]
        self.assertEqual((await self.adapter.dispatch_http_event(self.payload("/undo")))["status"], "error")
        self.assertEqual(self.session_calls, [])
        self.adapter.gateway_runner.hooks.emit_collect.return_value = [{"decision": "rewrite", "command_name": "undo", "raw_args": "2"}]
        self.assertTrue((await self.adapter.dispatch_http_event(self.payload("/undo")))["ok"])
        self.assertEqual(self.session_calls[0][0].text, "/undo 2")

    async def test_restart_waits_for_matching_native_reply_and_replays_receipt(self):
        request = self.payload()
        result = await self.adapter.dispatch_http_event(request)
        self.assertEqual(result, {"ok": True, "output": self.native_output})
        self.assertEqual(len(self.events), 1)
        event = self.events[0]
        self.assertEqual(event.text, "/restart")
        self.assertEqual(event.source.profile, "default")
        self.assertEqual(event.source.user_id, "mobile-api")
        self.assertEqual(event.source.chat_id, "mobile_session")
        self.assertEqual(event.message_id, request["request_id"])
        self.assertFalse(event.internal)
        self.assertTrue(self.adapter.authorization_is_upstream)
        self.assertEqual(await self.make_adapter().dispatch_http_event(request), result)
        self.assertEqual(len(self.events), 1)

    async def test_unsupported_invalid_profile_and_native_permission_refusal_do_not_dispatch(self):
        for payload in [self.payload("/goal test"), self.payload("/invented"), self.payload(profile_ref="other"),
                        self.payload("/restart\n/run"), self.payload(request_id="invalid"),
                        self.payload("//restart"), self.payload("/restart\u2028ignored"), self.payload("/restart\u2029ignored")]:
            result = await self.adapter.dispatch_http_event(payload)
            self.assertFalse(result["ok"])
            self.assertEqual(result["status"], "error")
        self.denied = "原生策略禁止执行 /restart。"
        result = await self.adapter.dispatch_http_event(self.payload())
        self.assertEqual(result, {"ok": False, "status": "error", "error": self.denied})
        self.assertEqual(self.events, [])

    async def test_secondary_profile_routes_only_to_its_native_home_scoped_adapter(self):
        target = SimpleNamespace(_command_profile="secondary", _command_home=(self.home / "secondary").resolve(),
                                 dispatch_http_event=AsyncMock(return_value={"commands": []}))
        self.adapter.gateway_runner._profile_adapters = {"secondary": {self.adapter.platform: target}}
        request = {"kind": "catalog", "profile_ref": "secondary"}
        self.assertEqual((await self.adapter.dispatch_http_event(request))["status"], "error")
        target.dispatch_http_event.assert_not_called()
        self.current_home = target._command_home
        self.assertEqual(await self.adapter.dispatch_http_event(request), {"commands": []})
        target.dispatch_http_event.assert_awaited_once_with(request)

    async def test_no_native_reply_is_unknown_and_never_reexecuted(self):
        from hermes_mobile_delivery import commands
        self.native_output = None
        request = self.payload()
        with patch.object(commands, "REPLY_TIMEOUT", 0.01):
            result = await self.adapter.dispatch_http_event(request)
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "unknown")
        replay = await self.make_adapter().dispatch_http_event(request)
        self.assertEqual(replay["status"], "unknown")
        self.assertEqual(len(self.events), 1)

    async def test_missing_native_permission_check_fails_closed_and_limit_matches_protocol(self):
        request = self.payload("/help " + "x" * (8192 - len("/help ")))
        self.assertTrue((await self.adapter.dispatch_http_event(request))["ok"])
        too_long = await self.adapter.dispatch_http_event(self.payload(request["command"] + "x"))
        self.assertEqual(too_long["status"], "error")
        self.adapter.gateway_runner._check_slash_access = None
        for command in ("/help", "/restart"):
            result = await self.adapter.dispatch_http_event(self.payload(command))
            self.assertEqual(result["status"], "error")
        self.assertEqual(self.events, [])

    async def test_other_reply_and_duplicate_request_cannot_complete_or_reexecute_restart(self):
        from hermes_mobile_delivery import commands
        self.native_output = None
        request = self.payload()
        executing = asyncio.create_task(self.adapter.dispatch_http_event(request))
        for _ in range(100):
            if self.events:
                break
            await asyncio.sleep(0.001)
        self.assertEqual(len(self.events), 1)
        self.assertFalse(await commands.capture_reply(self.adapter, "other-session", request["request_id"], "无关回复"))
        self.assertFalse(await commands.capture_reply(self.adapter, "mobile_session", str(uuid4()), "无关回复"))
        self.assertFalse(executing.done())
        duplicate = await self.adapter.dispatch_http_event(request)
        self.assertEqual(duplicate["status"], "unknown")
        self.assertEqual(len(self.events), 1)
        await self.adapter.send("mobile_session", "原生确认", reply_to=request["request_id"])
        self.assertEqual(await executing, {"ok": True, "output": "原生确认"})

    async def test_long_session_command_persists_final_metadata_for_read_only_poll(self):
        from hermes_mobile_delivery import commands
        self.session_gate = asyncio.Event()
        request = self.payload("/undo")
        with patch.object(commands, "REPLY_TIMEOUT", 0.01):
            result = await self.adapter.dispatch_http_event(request)
        self.assertEqual(result["status"], "unknown")
        poll = {key: value for key, value in request.items() if key != "command"}
        poll["kind"] = "result"
        self.assertEqual((await self.adapter.dispatch_http_event(poll))["status"], "unknown")
        self.assertEqual((await self.adapter.dispatch_http_event(self.payload("/undo")))["status"], "error")
        self.session_gate.set()
        await asyncio.gather(*(task for _, task in list(self.adapter._command_tasks.values())))
        final = await self.make_adapter().dispatch_http_event(poll)
        self.assertEqual(final, {"ok": True, "output": "原生撤回", "native_result": {"rewound_turns": 1}})
        self.assertEqual(len(self.session_calls), 1)
        self.assertEqual((await self.adapter.dispatch_http_event({**poll, "command": "/undo"}))["status"], "error")

    async def test_missing_receipt_stays_unknown_until_original_request_can_register(self):
        request = self.payload("/undo")
        poll = {key: value for key, value in request.items() if key != "command"}
        poll["kind"] = "result"
        self.assertEqual((await self.adapter.dispatch_http_event(poll))["status"], "unknown")
        self.assertTrue((await self.adapter.dispatch_http_event(request))["ok"])
        self.assertTrue((await self.adapter.dispatch_http_event(poll))["ok"])
