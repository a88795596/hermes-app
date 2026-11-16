import asyncio
from contextlib import contextmanager
from contextvars import ContextVar
from types import MethodType, ModuleType, SimpleNamespace
import sys
import unittest
from unittest.mock import patch

from hermes_mobile_delivery import compression


class CompressionTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.api = SimpleNamespace(_pending_agent_requests=0)
        self.profile = ContextVar("test_profile", default="wrong")
        self.context = SimpleNamespace(api=self.api, row={}, entry=SimpleNamespace(session_id="mobile_original"),
                                       original_session_id="mobile_original", event=object(), require_idle=lambda: None)

        @contextmanager
        def reserve(api):
            api._pending_agent_requests += 1
            reservation = {"active": True, "detached": False}
            try:
                yield reservation
            finally:
                if not reservation["detached"]:
                    release(api, reservation)

        def release(api, reservation):
            if reservation["active"]:
                reservation["active"] = False
                api._pending_agent_requests -= 1

        async def create(adapter, event):
            return self.context

        exports = {
            "gateway.platforms.api_server": {"_reserve_pending_api_work": reserve, "_release_pending_api_work": release},
            "hermes_mobile_delivery.session_commands": {"create_session_context": create},
            "hermes_mobile_delivery.commands": {
                "failure": lambda message, unknown=False: {"ok": False, "status": "unknown" if unknown else "error", "error": message},
                "output_result": lambda text: {"ok": True, "output": text}},
        }
        modules = {}
        for name, values in exports.items():
            modules[name] = ModuleType(name)
            modules[name].__dict__.update(values)
        mocking = patch.dict(sys.modules, modules)
        mocking.start()
        self.addCleanup(mocking.stop)

    async def test_native_handler_keeps_profile_in_executor_and_reports_actual_rotation(self):
        async def handler(event):
            profile = await asyncio.get_running_loop().run_in_executor(None, self.profile.get)
            self.assertEqual(profile, "work")
            self.context.entry.session_id = "compressed_child"
            return "原生压缩结果"
        self.context._handle_compress_command = handler
        token = self.profile.set("work")
        try:
            result = await asyncio.create_task(compression.execute_compression(object(), object()))
        finally:
            self.profile.reset(token)
        await asyncio.sleep(0)
        self.assertEqual(result, {"ok": True, "output": "原生压缩结果", "native_result": {"session_id": "compressed_child"}})
        self.assertEqual(self.api._pending_agent_requests, 0)

    async def test_preview_does_not_resolve_provider_or_rebind_existing_tip(self):
        self.context.original_session_id = "old_parent"
        async def handler(event):
            return "原生预览"
        self.context._handle_compress_command = handler
        with patch.object(compression, "_api_runtime", side_effect=AssertionError("preview cannot resolve provider")):
            result = await asyncio.create_task(compression.execute_compression(object(), object()))
        self.assertEqual(result, {"ok": True, "output": "原生预览"})

    async def test_busy_session_is_rejected_before_handler_or_reservation(self):
        def busy():
            raise ValueError("请先停止当前回复")
        self.context.require_idle = busy
        result = await compression.execute_compression(object(), object())
        self.assertEqual(result["status"], "error")
        self.assertEqual(self.api._pending_agent_requests, 0)

    async def test_api_runtime_uses_native_persisted_lock_without_constructing_or_closing_agent(self):
        calls = []
        class ForbiddenAgent:
            def __init__(self, **kwargs):
                raise AssertionError("The real AIAgent constructor must never run")
        native_module = ModuleType("run_agent")
        native_module.AIAgent = ForbiddenAgent
        self.context.row = {"model": "old-model"}
        self.context.entry.session_key = "mobile_original"
        self.api._effective_session_runtime_request = lambda **kwargs: {
            "require_model_lock": True, "requested": {"model": "locked-model", "provider": "provider"},
            "route": {"model": "locked-model"}, "model_options": {"reasoning_effort": "high"}}
        def create(self, **kwargs):
            from run_agent import AIAgent
            calls.append(kwargs)
            return AIAgent(model="locked-model", provider="provider", api_key="secret",
                           base_url="https://provider.test", api_mode="responses",
                           requested_provider="native-acp", command="/native/acp", args=["--session"],
                           max_iterations=90, skip_memory=False)
        self.api._create_agent = MethodType(create, self.api)
        original_globals = create.__globals__["__builtins__"]
        with patch.dict(sys.modules, {"run_agent": native_module}):
            model, runtime = compression._api_runtime(self.context)
            self.assertIs(native_module.AIAgent, ForbiddenAgent)
        self.assertIs(create.__globals__["__builtins__"], original_globals)
        self.assertEqual(model, "locked-model")
        self.assertEqual(runtime["provider"], "provider")
        self.assertEqual(runtime["requested_provider"], "native-acp")
        self.assertEqual(runtime["command"], "/native/acp")
        self.assertEqual(runtime["args"], ["--session"])
        self.assertNotIn("max_iterations", runtime)
        self.assertNotIn("skip_memory", runtime)
        self.assertTrue(calls[0]["confirmed_runtime_lock"])
        self.assertEqual(calls[0]["gateway_session_key"], "mobile_original")
        self.assertIsNone(calls[0]["session_model"])
        self.assertEqual(len(calls), 1)

    async def test_unknown_runtime_factory_fails_without_invoking_it(self):
        def unrelated(self, **kwargs):
            raise AssertionError("Unsupported native factory must not run")
        self.api._create_agent = MethodType(unrelated, self.api)
        with self.assertRaises(RuntimeError):
            compression._capture_agent_arguments(self.api)
