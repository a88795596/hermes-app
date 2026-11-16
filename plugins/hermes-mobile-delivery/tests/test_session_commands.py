import asyncio
from contextlib import contextmanager
from dataclasses import dataclass, field
from enum import Enum
import importlib
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch


class Platform(str, Enum):
    API_SERVER = "api_server"
    MOBILE = "hermes_mobile"


@dataclass
class Source:
    chat_id: str
    platform: Platform = Platform.MOBILE
    profile: str = "work"
    user_id: str = "mobile-api"
    chat_type: str = "dm"


@dataclass
class Event:
    text: str
    source: Source = field(default_factory=lambda: Source("mobile_session"))
    raw_message: dict = field(default_factory=lambda: {"hermes_mobile_approval": "once"})

    def get_command_args(self):
        parts = self.text.split(maxsplit=1)
        return parts[1] if len(parts) > 1 else ""


class SessionCommandTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.home = Path(directory.name)
        self.calls = []
        case = self

        class DB:
            db_path = case.home / "state.db"
            row = {"id": "mobile_session", "source": "api_server", "started_at": 1, "last_active": 2, "title": "原题"}
            extra_rows = {}

            def get_session(self, session_id):
                case.calls.append(("get", session_id))
                return self.row.copy() if self.row and self.row["id"] == session_id else self.extra_rows.get(session_id)

            def resolve_resume_session_id(self, session_id):
                return session_id

            def get_session_title(self, session_id):
                return self.row["title"]

        class NativeStore:
            def load_transcript(self, session_id):
                case.calls.append(("history", session_id))
                return [{"role": "user", "content": "既有会话"}]

            def rewind_session(self, session_id, count):
                case.calls.append(("native-rewind", session_id, count))
                return {"turns_undone": min(count, 2), "rewound_count": 4, "target_text": "旧消息"}

            def reset_session(self, session_key):
                old = self._entries[session_key]
                case.db.row["end_reason"] = "session_reset"
                case.db.extra_rows["native_new_id"] = {"id": "native_new_id", "source": "api_server"}
                new = SimpleNamespace(**{**vars(old), "session_id": "native_new_id"})
                self._entries[session_key] = new
                case.calls.append(("native-reset", session_key))
                return new

        class AsyncView:
            def __init__(self, db):
                self._db = self._store = db

            def __getattr__(self, key):
                attr = getattr(self._db, key)
                async def call(*args, **kwargs):
                    return attr(*args, **kwargs)
                return call if callable(attr) else attr

        class NativeHandlers:
            @staticmethod
            def _fenced_truncated_diff(diff):
                return "\n".join(diff.splitlines())

            async def _handle_diff_command(self, event):
                return self._fenced_truncated_diff("原生差异\n第二行")

            async def _handle_reset_command(self, event):
                key = self._session_key_for_source(event.source)
                self._clear_conversation_scope(key, reason="session_reset")
                await self.async_session_store.reset_session(key)
                return "原生新会话"

            async def _handle_undo_command(self, event):
                entry = await self.async_session_store.get_or_create_session(event.source)
                result = await self.async_session_store.rewind_session(entry.session_id, int(event.get_command_args() or "1"))
                self._evict_cached_agent(entry.session_key)
                return f"原生撤回 {result['turns_undone']} 轮"

            async def _handle_usage_command(self, event):
                entry = await self.async_session_store.get_or_create_session(event.source)
                history = await self.async_session_store.load_transcript(entry.session_id)
                case.calls.append(("native-usage", event.source.platform.value, history[0]["content"]))
                return "原生用量"

            async def _handle_status_command(self, event):
                entry = await self.async_session_store.get_or_create_session(event.source)
                case.calls.append(("native-status", entry.session_id, self._queue_depth(entry.session_key)))
                return "原生状态"

            async def _handle_title_command(self, event):
                entry = await self.async_session_store.get_or_create_session(event.source)
                case.calls.append(("native-title", entry.session_id, event.get_command_args()))
                case.db.row["title"] = event.get_command_args().strip()
                return "原生标题"

        class NativeRunner:
            async def _maybe_confirm_destructive_slash(self, *, event, command, title, detail, execute):
                case.calls.append(("native-confirm", command, detail))

                async def resolve(choice):
                    case.calls.append(("native-confirm-choice", choice))
                    return await execute()

                return await self._request_slash_confirm(event=event, command=command, title=title,
                    message=f"原生确认 {command}", handler=resolve)

        exports = {
            "gateway.config": {"Platform": Platform},
            "gateway.session": {"SessionStore": NativeStore, "AsyncSessionStore": AsyncView, "SessionEntry": SimpleNamespace},
            "gateway.slash_commands": {"GatewaySlashCommandsMixin": NativeHandlers},
            "gateway.run": {"GatewayRunner": NativeRunner},
            "hermes_state": {"AsyncSessionDB": AsyncView, "SessionDB": SimpleNamespace(sanitize_title=str.strip)},
            "hermes_constants": {"get_hermes_home": lambda: self.home},
            "agent.redact": {"redact_sensitive_text": lambda text, **kwargs: text},
        }

        def release_work(api, reservation):
            if reservation["active"]:
                reservation["active"] = False
                api._pending_agent_requests -= 1

        @contextmanager
        def reserve_work(api):
            reservation = {"active": True, "detached": False}
            api._pending_agent_requests += 1
            try:
                yield reservation
            finally:
                if not reservation["detached"]:
                    release_work(api, reservation)

        exports["gateway.platforms.api_server"] = {
            "_reserve_pending_api_work": reserve_work,
            "_release_pending_api_work": release_work,
        }
        modules = {}
        for name, values in exports.items():
            module = ModuleType(name)
            module.__dict__.update(values)
            modules[name] = module
        mocking = patch.dict(sys.modules, modules)
        mocking.start()
        self.addCleanup(mocking.stop)
        self.db = DB()
        async def ensure_db():
            return self.db
        self.api = SimpleNamespace(_ensure_session_db_async=ensure_db, _run_statuses={}, _active_run_tasks={},
            _active_run_agents={}, _pending_agent_requests=0)
        self.runner = SimpleNamespace(adapters={Platform.API_SERVER: self.api},
            _evict_cached_agent=lambda key: self.calls.append(("evict", key)),
            _clear_conversation_scope=lambda key, **kwargs: self.calls.append(("clear-scope", key)))
        self.adapter = SimpleNamespace(gateway_runner=self.runner)
        self.module = importlib.import_module("hermes_mobile_delivery.session_commands")

    async def test_undo_calls_native_handler_on_existing_session_and_returns_actual_rewind(self):
        result = await self.module.execute_session_command(self.adapter, Event("/undo 5"), "undo")
        self.assertEqual(result, {"ok": True, "output": "原生撤回 2 轮", "native_result": {"rewound_turns": 2}})
        self.assertIn(("native-rewind", "mobile_session", 5), self.calls)
        self.assertFalse(hasattr(self.runner, "session_store"), "不能向真实网关写入额外会话路由")

    async def test_usage_and_status_use_existing_history_and_native_api_platform(self):
        for name in ("usage", "status"):
            result = await self.module.execute_session_command(self.adapter, Event(f"/{name}"), name)
            self.assertTrue(result["ok"])
        self.assertIn(("history", "mobile_session"), self.calls)
        self.assertIn(("native-usage", "api_server", "既有会话"), self.calls)

    async def test_native_title_returns_only_confirmed_persisted_title(self):
        result = await self.module.execute_session_command(self.adapter, Event("/title 新标题"), "title")
        self.assertEqual(result["native_result"], {"title": "新标题"})
        self.assertIn(("native-title", "mobile_session", "新标题"), self.calls)

    async def test_undo_rejects_queued_running_and_still_alive_workers(self):
        for status in ("queued", "running", "waiting_for_approval", "stopping"):
            self.api._run_statuses = {"run": {"session_id": "mobile_session", "status": status}}
            result = await self.module.execute_session_command(self.adapter, Event("/undo"), "undo")
            self.assertFalse(result["ok"], status)
        self.api._run_statuses = {}
        self.api._active_run_agents = {"run": SimpleNamespace(session_id="mobile_session")}
        self.assertFalse((await self.module.execute_session_command(self.adapter, Event("/undo"), "undo"))["ok"])
        self.assertFalse(any(call[0] == "native-rewind" for call in self.calls))

    async def test_wrong_profile_database_or_missing_session_never_reaches_native_handler(self):
        self.db.db_path = self.home / "other" / "state.db"
        result = await self.module.execute_session_command(self.adapter, Event("/undo"), "undo")
        self.assertFalse(result["ok"])
        self.db.db_path = self.home / "state.db"
        self.db.row = None
        result = await self.module.execute_session_command(self.adapter, Event("/undo"), "undo")
        self.assertFalse(result["ok"])
        self.assertFalse(any(call[0] == "native-rewind" for call in self.calls))

    async def test_busy_guard_covers_unscoped_requests_but_ignores_finished_agent_references(self):
        for key in ("_pending_agent_requests", "_inflight_agent_runs"):
            setattr(self.api, key, 1)
            self.assertFalse((await self.module.execute_session_command(self.adapter, Event("/undo"), "undo"))["ok"])
            setattr(self.api, key, 0)
        self.api._active_run_tasks = {"unknown": SimpleNamespace(done=lambda: False)}
        self.assertFalse((await self.module.execute_session_command(self.adapter, Event("/undo"), "undo"))["ok"])
        self.api._active_run_tasks = {"completed": SimpleNamespace(done=lambda: True)}
        self.api._run_statuses = {"completed": {"session_id": "mobile_session", "status": "completed"}}
        self.api._active_run_agents = {"completed": SimpleNamespace(session_id="mobile_session")}
        self.assertTrue((await self.module.execute_session_command(self.adapter, Event("/undo"), "undo"))["ok"])

    async def test_new_uses_native_reset_and_confirms_new_durable_session(self):
        result = await self.module.execute_session_command(self.adapter, Event("/new"), "new")
        self.assertEqual(result, {"ok": True, "output": "原生新会话", "native_result": {"session_id": "native_new_id", "reset": True}})
        self.assertIn(("native-reset", "mobile_session"), self.calls)
        self.assertIn(("clear-scope", "mobile_session"), self.calls)

    async def test_new_refuses_to_reset_an_active_session(self):
        self.api._run_statuses = {"run": {"session_id": "mobile_session", "status": "running"}}
        result = await self.module.execute_session_command(self.adapter, Event("/new"), "new")
        self.assertFalse(result["ok"])
        self.assertFalse(any(call[0] == "native-reset" for call in self.calls))

    async def test_native_static_helper_keeps_its_descriptor_binding(self):
        result = await self.module.execute_session_command(self.adapter, Event("/diff"), "diff")
        self.assertEqual(result, {"ok": True, "output": "原生差异\n第二行"})

    async def test_continued_session_is_used_without_rebinding_read_or_undo_result(self):
        self.db.extra_rows["compressed_child"] = {**self.db.row, "id": "compressed_child"}
        self.db.resolve_resume_session_id = lambda session_id: "compressed_child"
        for name in ("status", "usage", "undo"):
            result = await self.module.execute_session_command(self.adapter, Event(f"/{name}"), name)
            self.assertTrue(result["ok"], result)
            self.assertNotIn("session_id", result.get("native_result", {}))
        self.assertIn(("native-status", "compressed_child", 0), self.calls)
        self.assertIn(("native-rewind", "compressed_child", 1), self.calls)

    async def test_mutation_reservation_lasts_until_receipt_task_finishes(self):
        receipt_saved = asyncio.Event()
        handler_done = asyncio.Event()

        async def command_and_receipt():
            result = await self.module.execute_session_command(self.adapter, Event("/undo"), "undo")
            handler_done.set()
            await receipt_saved.wait()
            return result

        task = asyncio.create_task(command_and_receipt())
        await handler_done.wait()
        self.assertEqual(self.api._pending_agent_requests, 1)
        receipt_saved.set()
        self.assertTrue((await task)["ok"])
        await asyncio.sleep(0)
        self.assertEqual(self.api._pending_agent_requests, 0)

    async def test_unapproved_new_and_undo_return_native_prompt_without_mutation(self):
        for name in ("new", "undo"):
            result = await self.module.execute_session_command(self.adapter, Event(f"/{name}", raw_message={}), name)
            self.assertEqual(result, {"ok": True, "output": f"原生确认 {name}",
                "native_result": {"confirmation": f"原生确认 {name}"}})
        self.assertFalse(any(call[0] in {"native-reset", "native-rewind", "clear-scope", "native-confirm-choice"}
                             for call in self.calls))
        self.assertEqual(self.api._pending_agent_requests, 0)

    async def test_always_passes_choice_to_original_native_callback(self):
        result = await self.module.execute_session_command(self.adapter,
            Event("/undo 2", raw_message={"hermes_mobile_approval": "always"}), "undo")
        self.assertTrue(result["ok"])
        self.assertIn(("native-confirm-choice", "always"), self.calls)
        self.assertIn(("native-confirm", "undo", "This removes the last 2 user turns from history."), self.calls)

    async def test_confirmation_cannot_execute_under_a_different_profile_scope(self):
        context = await self.module.create_session_context(self.adapter, Event("/undo"))
        called = False

        async def callback(choice):
            nonlocal called
            called = True

        with patch("hermes_constants.get_hermes_home", return_value=self.home / "other"):
            with self.assertRaises(ValueError):
                await context._request_slash_confirm(event=context.event, command="undo", title="/undo",
                    message="确认", handler=callback)
        self.assertFalse(called)
