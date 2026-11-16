"""Bind original Hermes handlers to an existing API session without creating a gateway route."""

import asyncio
from dataclasses import replace
from datetime import datetime, timezone
import inspect
from pathlib import Path
import threading


SESSION_COMMANDS = frozenset({"new", "undo", "usage", "status", "title", "context", "diff"})
TERMINAL_RUNS = frozenset({"completed", "failed", "cancelled"})


def _session_store(db, entry, config):
    from gateway.session import SessionStore

    class ExistingSessionStore(SessionStore):
        def __init__(self):
            self._db = db
            self.config = config
            self._entries = {entry.session_key: entry}
            self._lock = threading.RLock()
            self._transcript_retry_lock = threading.Lock()
            self._transcript_drain_lock = threading.RLock()
            self._transcript_reroutes = {}
            self._dirty_transcripts = {}
            self._transcript_append_failures = {}
            self.rewound_turns = 0

        def get_or_create_session(self, source, force_new=False):
            if source.chat_id != entry.origin.chat_id or force_new:
                raise ValueError("会话命令不能创建或替换未授权的会话。")
            return self._entries[entry.session_key]

        def _ensure_loaded_locked(self):
            pass

        def _save(self):
            # API sessions own their IDs; this view must not publish gateway routes.
            pass

        def _record_gateway_session_peer(self, *args, **kwargs):
            pass

        def rewind_session(self, session_id, n=1):
            result = super().rewind_session(session_id, n)
            if result:
                self.rewound_turns = result["turns_undone"]
            return result

    return ExistingSessionStore()


class NativeSessionContext:
    def __init__(self, runner, api, event, db, row):
        from gateway.session import AsyncSessionStore, SessionEntry
        from hermes_state import AsyncSessionDB

        self.runner, self.api, self.event, self.db, self.row = runner, api, event, db, row
        self.confirmation = None
        self.original_session_id = event.source.chat_id
        now = datetime.now(timezone.utc)
        self.entry = SessionEntry(session_key=self.original_session_id, session_id=row["id"],
            created_at=datetime.fromtimestamp(row["started_at"], timezone.utc) if row.get("started_at") else now,
            updated_at=datetime.fromtimestamp(row["last_active"], timezone.utc) if row.get("last_active") else now,
            origin=event.source, platform=event.source.platform, chat_type=event.source.chat_type,
            last_prompt_tokens=0)
        self.session_store = _session_store(db, self.entry, getattr(runner, "config", None))
        self.async_session_store = AsyncSessionStore(self.session_store)
        self._session_db = AsyncSessionDB(db)
        self.adapters = runner.adapters
        self._agent_cache = {}
        self._agent_cache_lock = threading.Lock()
        agents = [agent for run_id, agent in getattr(api, "_active_run_agents", {}).items()
                  if (getattr(agent, "session_id", None) in self.session_ids
                      or getattr(api, "_run_statuses", {}).get(run_id, {}).get("session_id") in self.session_ids)
                  and self._run_active(run_id)]
        self._running_agents = {self.entry.session_key: agents[-1]} if agents else {}

    @property
    def session_ids(self):
        return {self.original_session_id, self.entry.session_id}

    @property
    def busy(self):
        if getattr(self.api, "_pending_agent_requests", 0) or getattr(self.api, "_inflight_agent_runs", 0):
            return True
        statuses = getattr(self.api, "_run_statuses", {})
        for run_id, task in getattr(self.api, "_active_run_tasks", {}).items():
            if not task.done() and not statuses.get(run_id, {}).get("session_id"):
                return True
        for run_id, row in statuses.items():
            if row.get("session_id") not in self.session_ids:
                continue
            if self._run_active(run_id):
                return True
        return bool(self._running_agents)

    def _run_active(self, run_id):
        row = getattr(self.api, "_run_statuses", {}).get(run_id, {})
        task = getattr(self.api, "_active_run_tasks", {}).get(run_id)
        return row.get("status") not in TERMINAL_RUNS or (task is not None and not task.done())

    def require_idle(self):
        if self.busy:
            raise ValueError("请先停止当前回复，再修改会话历史。")

    def _queue_depth(self, session_key, adapter=None):
        return sum(row.get("session_id") in self.session_ids and row.get("status") == "queued"
                   for row in getattr(self.api, "_run_statuses", {}).values())

    def _session_key_for_source(self, source):
        return self.entry.session_key

    def _evict_cached_agent(self, session_key):
        evict = getattr(self.runner, "_evict_cached_agent", None)
        if callable(evict):
            evict(self.entry.session_key)

    async def _request_slash_confirm(self, *, event, command, title, message, handler):
        from hermes_constants import get_hermes_home

        raw = getattr(event, "raw_message", None)
        approval = raw.get("hermes_mobile_approval") if isinstance(raw, dict) else None
        if approval not in {"once", "always"}:
            self.confirmation = message
            return message
        # Resolve the original native callback immediately within the same
        # authenticated profile scope; never retain a cross-request closure.
        if Path(get_hermes_home()).resolve() != Path(self.db.db_path).resolve().parent:
            raise ValueError("Hermes 确认请求与当前配置档案不匹配。")
        return await handler(approval)

    def __getattr__(self, name):
        from gateway.slash_commands import GatewaySlashCommandsMixin

        handler = inspect.getattr_static(GatewaySlashCommandsMixin, name, None)
        if handler is not None:
            return handler.__get__(self, type(self)) if hasattr(handler, "__get__") else handler
        return getattr(self.runner, name)


async def create_session_context(adapter, event):
    from gateway.config import Platform
    from hermes_constants import get_hermes_home

    runner = adapter.gateway_runner
    api = runner.adapters.get(Platform("api_server"))
    if api is None:
        raise ValueError("Hermes API 会话运行环境尚未连接。")
    db = await api._ensure_session_db_async()
    if db is None or Path(db.db_path).resolve().parent != Path(get_hermes_home()).resolve():
        raise ValueError("Hermes 会话数据库与当前配置档案不匹配。")
    requested = event.source.chat_id
    original = await asyncio.to_thread(db.get_session, requested)
    if not original:
        raise ValueError("当前 Hermes 会话不存在。")
    session_id = await asyncio.to_thread(db.resolve_resume_session_id, requested)
    row = original if session_id == requested else await asyncio.to_thread(db.get_session, session_id)
    if not row:
        raise ValueError("无法找到当前 Hermes 会话的有效历史。")
    event = replace(event, source=replace(event.source, platform=Platform("api_server")))
    return NativeSessionContext(runner, api, event, db, row)


async def execute_session_command(adapter, event, name):
    from .commands import failure, output_result

    if name not in SESSION_COMMANDS:
        return failure("此会话命令没有已注册的原生处理程序。")
    try:
        context = await create_session_context(adapter, event)
    except Exception as error:
        return failure(str(error) if isinstance(error, ValueError) else "无法读取当前 Hermes 会话。")
    if name in {"undo", "new"} and context.busy:
        return failure("请先停止当前回复，再修改会话历史。")
    try:
        previous_session_id = context.entry.session_id
        handler = "reset" if name == "new" else name

        async def execute():
            if name in {"undo", "new"}:
                context.require_idle()
            if name in {"undo", "new", "title"}:
                from gateway.platforms.api_server import _release_pending_api_work, _reserve_pending_api_work

                # The command task also persists its receipt. Keep native
                # restart draining through that persistence, after approval.
                with _reserve_pending_api_work(context.api) as reservation:
                    task = asyncio.current_task()
                    if task is not None:
                        reservation["detached"] = True
                        task.add_done_callback(lambda _: _release_pending_api_work(context.api, reservation))
            return await getattr(context, f"_handle_{handler}_command")(context.event)

        if name in {"undo", "new"}:
            from gateway.run import GatewayRunner

            detail = "This starts a fresh session and discards the current conversation history."
            if name == "undo":
                try:
                    count = max(1, int(context.event.get_command_args().strip().split()[0]))
                except (ValueError, IndexError):
                    count = 1
                detail = ("This removes the last user/assistant exchange from history." if count == 1
                          else f"This removes the last {count} user turns from history.")
            output = await GatewayRunner._maybe_confirm_destructive_slash(context,
                event=context.event, command=name, title=f"/{name}", detail=detail, execute=execute)
        else:
            output = await execute()
        result = output_result(output)
        if context.confirmation is not None:
            result["native_result"] = {"confirmation": result["output"]}
            return result
        metadata = {}
        if name == "new":
            context.entry = context.session_store._entries[context.entry.session_key]
            row = await context._session_db.get_session(context.entry.session_id)
            previous = await context._session_db.get_session(previous_session_id)
            if (context.entry.session_id == previous_session_id or not row
                    or not previous or previous.get("end_reason") != "session_reset"):
                return failure("无法确认 Hermes 新会话是否已保存，请刷新后查看。", unknown=True)
            metadata["reset"] = True
            if isinstance(row.get("title"), str) and row["title"]:
                metadata["title"] = row["title"]
        if context.session_store.rewound_turns:
            metadata["rewound_turns"] = context.session_store.rewound_turns
        if name == "title" and event.get_command_args().strip():
            from hermes_state import SessionDB

            requested_title = SessionDB.sanitize_title(event.get_command_args().strip())
            title = await context._session_db.get_session_title(context.entry.session_id)
            if requested_title and title == requested_title:
                metadata["title"] = title
        if name == "new" and context.entry.session_id != context.original_session_id:
            metadata["session_id"] = context.entry.session_id
        if metadata:
            result["native_result"] = metadata
        return result
    except Exception:
        return failure("无法确认 Hermes 会话命令的执行结果，请刷新后查看。", unknown=name in {"new", "undo", "title"})
