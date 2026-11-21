"""Hermes 插件私有的持久化投递队列。"""

from contextlib import closing, contextmanager
import json
import mimetypes
from pathlib import Path
import os
import sqlite3
import stat
import time
import unicodedata
from uuid import uuid4


MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
MAX_ATTACHMENTS = 10


@contextmanager
def _connect(path: Path):
    if not path.is_absolute():
        raise ValueError("投递队列必须使用绝对路径")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory = path.parent.lstat()
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != os.getuid() or directory.st_mode & 0o077:
        raise PermissionError("投递队列目录必须由当前用户拥有，且仅该用户可访问")

    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        file = os.fstat(fd)
        if not stat.S_ISREG(file.st_mode) or file.st_uid != os.getuid() or file.st_mode & 0o077:
            raise PermissionError("投递队列文件必须由当前用户拥有，且仅该用户可访问")
    finally:
        os.close(fd)

    with closing(sqlite3.connect(path.as_uri() + "?mode=rw", uri=True)) as db, db:
        db.execute("PRAGMA synchronous = FULL")
        db.execute("PRAGMA foreign_keys = ON")
        db.execute("""CREATE TABLE IF NOT EXISTS deliveries (
            delivery_id TEXT PRIMARY KEY,
            profile_ref TEXT NOT NULL,
            text TEXT NOT NULL
        )""")
        db.execute("""CREATE TABLE IF NOT EXISTS delivery_sessions (
            delivery_id TEXT PRIMARY KEY REFERENCES deliveries(delivery_id) ON DELETE CASCADE,
            session_id TEXT NOT NULL
        )""")
        db.execute("""CREATE TABLE IF NOT EXISTS delivery_notices (
            delivery_id TEXT PRIMARY KEY REFERENCES delivery_sessions(delivery_id) ON DELETE CASCADE,
            kind TEXT NOT NULL CHECK (kind IN ('warning', 'progress', 'review_summary'))
        )""")
        db.execute("""CREATE TABLE IF NOT EXISTS attachments (
            attachment_id TEXT PRIMARY KEY,
            delivery_id TEXT NOT NULL REFERENCES deliveries(delivery_id) ON DELETE CASCADE,
            position INTEGER NOT NULL,
            name TEXT NOT NULL,
            mime TEXT NOT NULL,
            content BLOB NOT NULL
        )""")
        db.execute("""CREATE TABLE IF NOT EXISTS delivery_state (
            delivery_id TEXT PRIMARY KEY REFERENCES deliveries(delivery_id) ON DELETE CASCADE,
            state TEXT NOT NULL DEFAULT 'queued',
            created_at REAL NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            retry_count INTEGER NOT NULL DEFAULT 0,
            last_attempt_at REAL,
            next_attempt_at REAL NOT NULL DEFAULT 0,
            attempt_token TEXT,
            http_status INTEGER,
            error_code TEXT
        )""")
        db.execute("""CREATE TABLE IF NOT EXISTS profile_pauses (
            profile_ref TEXT PRIMARY KEY,
            paused_until REAL NOT NULL
        )""")
        db.execute("""CREATE TABLE IF NOT EXISTS command_receipts (
            request_id TEXT PRIMARY KEY,
            profile_ref TEXT NOT NULL,
            session_id TEXT NOT NULL,
            command TEXT NOT NULL,
            result TEXT
        )""")
        db.execute("""CREATE TABLE IF NOT EXISTS fast_selections (
            profile_ref TEXT NOT NULL, session_id TEXT NOT NULL, service_tier TEXT NOT NULL,
            PRIMARY KEY (profile_ref, session_id)
        )""")
        now = time.time()
        db.execute("""INSERT OR IGNORE INTO delivery_state (delivery_id, created_at, next_attempt_at)
            SELECT delivery_id, ?, ? FROM deliveries""", (now, now))
        yield db


def start_command(path: Path, profile_ref: str, request_id: str, session_id: str,
                  command: str) -> tuple[bool, dict | None]:
    with _connect(path) as db:
        inserted = db.execute("""INSERT OR IGNORE INTO command_receipts
            (request_id, profile_ref, session_id, command) VALUES (?, ?, ?, ?)""",
            (request_id, profile_ref, session_id, command)).rowcount
        if inserted:
            return True, None
        row = db.execute("""SELECT profile_ref, session_id, command, result
            FROM command_receipts WHERE request_id = ?""", (request_id,)).fetchone()
        if row[:3] != (profile_ref, session_id, command):
            raise ValueError("同一命令请求编号不能用于其他档案、会话或命令")
        return False, json.loads(row[3]) if row[3] is not None else {
            "ok": False, "status": "unknown", "error": "无法确认此前命令是否已执行，请勿重复执行。",
        }


def fast_selection(path: Path, profile_ref: str, session_id: str) -> str | None:
    with _connect(path) as db:
        row = db.execute("SELECT service_tier FROM fast_selections WHERE profile_ref = ? AND session_id = ?",
                         (profile_ref, session_id)).fetchone()
        return row[0] if row else None


def finish_command(path: Path, profile_ref: str, request_id: str, result: dict, *, fast_selection="unchanged") -> None:
    with _connect(path) as db:
        row = db.execute("SELECT session_id, command, result FROM command_receipts WHERE request_id = ? AND profile_ref = ?",
                         (request_id, profile_ref)).fetchone()
        if row is None:
            raise ValueError("命令回执不存在或不属于当前配置档案")
        if fast_selection != "unchanged":
            command = json.loads(row[1])[0] if row[1].startswith("[") else row[1]
            if fast_selection not in {None, "priority", "normal"} or not result.get("ok") or command.split()[0].lower() != "/fast":
                raise ValueError("快速模式回执无效")
            if row[2] is not None:
                return  # A late duplicate receipt must not restore an older selection.
            if fast_selection is None:
                db.execute("DELETE FROM fast_selections WHERE profile_ref = ? AND session_id = ?", (profile_ref, row[0]))
            else:
                db.execute("""INSERT INTO fast_selections VALUES (?, ?, ?)
                    ON CONFLICT (profile_ref, session_id) DO UPDATE SET service_tier = excluded.service_tier""",
                    (profile_ref, row[0], fast_selection))
        metadata = result.get("native_result", {})
        if result.get("ok") and metadata.get("session_id") and not metadata.get("reset"):
            db.execute("""INSERT OR IGNORE INTO fast_selections (profile_ref, session_id, service_tier)
                SELECT profile_ref, ?, service_tier FROM fast_selections WHERE profile_ref = ? AND session_id = ?""",
                (metadata["session_id"], profile_ref, row[0]))
        changed = db.execute("""UPDATE command_receipts SET result = ?
            WHERE request_id = ? AND profile_ref = ?""",
            (json.dumps(result, ensure_ascii=False, allow_nan=False), request_id, profile_ref)).rowcount
        if not changed:
            raise ValueError("命令回执不存在或不属于当前配置档案")


def read_command(path: Path, profile_ref: str, request_id: str, session_id: str) -> dict | None:
    with _connect(path) as db:
        row = db.execute("""SELECT profile_ref, session_id, result FROM command_receipts
            WHERE request_id = ?""", (request_id,)).fetchone()
        if row is None:
            return None
        if row[:2] != (profile_ref, session_id):
            raise ValueError("命令回执不属于当前配置档案或会话")
        return json.loads(row[2]) if row[2] is not None else {
            "ok": False, "status": "unknown", "error": "命令尚无最终回执，请查询原请求，不要重新执行。",
        }


def enqueue(path: Path, profile_ref: str, text: str, files=(), *, session_id: str | None = None,
            notice_kind: str | None = None) -> str:
    if len(files) > MAX_ATTACHMENTS:
        raise ValueError("每条消息最多包含 10 个附件")
    if notice_kind is not None and (notice_kind not in {"warning", "progress", "review_summary"} or not session_id or files):
        raise ValueError("会话状态提示无效")
    delivery_id = str(uuid4())
    with _connect(path) as db:
        db.execute("INSERT INTO deliveries VALUES (?, ?, ?)", (delivery_id, profile_ref, text))
        now = time.time()
        db.execute("INSERT INTO delivery_state (delivery_id, created_at, next_attempt_at) VALUES (?, ?, ?)",
                   (delivery_id, now, now))
        if session_id is not None:
            db.execute("INSERT INTO delivery_sessions VALUES (?, ?)", (delivery_id, session_id))
        if notice_kind is not None:
            db.execute("INSERT INTO delivery_notices VALUES (?, ?)", (delivery_id, notice_kind))
        for position, (source, display_name) in enumerate(files):
            source = Path(source)
            name = source.name if display_name is None else display_name
            if (not isinstance(name, str) or not name.strip() or name.strip() in {".", ".."}
                    or any(char in "/\\" or unicodedata.category(char) == "Cc" for char in name)
                    or len(name.encode("utf-8")) > 200):
                raise ValueError("附件名称无效或超过 200 字节")
            name = name.strip()
            fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as file:
                info = os.fstat(file.fileno())
                if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_ATTACHMENT_BYTES:
                    raise ValueError("附件必须为非空的普通文件，且不超过 50 MiB")
                content = file.read(MAX_ATTACHMENT_BYTES + 1)
                after = os.fstat(file.fileno())
                if len(content) != info.st_size or after.st_mtime_ns != info.st_mtime_ns or after.st_size != info.st_size:
                    raise ValueError("附件正在变化，请在生成完毕后重试")
            mime = {".md": "text/markdown", ".markdown": "text/markdown", ".html": "text/html",
                    ".htm": "text/html", ".m4a": "audio/mp4"}.get(source.suffix.lower())
            mime = mime or mimetypes.guess_type(source.name)[0] or "application/octet-stream"
            db.execute("INSERT INTO attachments VALUES (?, ?, ?, ?, ?, ?)",
                       (str(uuid4()), delivery_id, position, name, mime.lower(), content))
    return delivery_id


def pull(path: Path, profile_ref: str, limit: int = 20) -> list[tuple[str, str]]:
    if not path.exists():
        return []
    with _connect(path) as db:
        return db.execute("SELECT delivery_id, text FROM deliveries WHERE profile_ref = ? ORDER BY rowid LIMIT ?",
                          (profile_ref, limit)).fetchall()


def due(path: Path, profile_ref: str, limit: int = 20) -> list[tuple[str, str]]:
    if not path.exists():
        return []
    with _connect(path) as db:
        now = time.time()
        return db.execute("""SELECT d.delivery_id, d.text FROM deliveries d
            JOIN delivery_state s USING (delivery_id)
            WHERE d.profile_ref = ? AND s.state IN ('queued', 'retryable', 'auth_blocked', 'delivering')
                AND s.next_attempt_at <= ? AND NOT EXISTS (
                    SELECT 1 FROM profile_pauses WHERE profile_ref = ? AND paused_until > ?)
            ORDER BY s.next_attempt_at, d.rowid LIMIT ?""", (profile_ref, now, profile_ref, now, limit)).fetchall()


def begin_attempt(path: Path, profile_ref: str, delivery_id: str) -> str | None:
    if not path.exists():
        return None
    with _connect(path) as db:
        now = time.time()
        token = str(uuid4())
        # 覆盖 10 个附件及消息各 3 次、每次 30 秒的网络尝试。
        changed = db.execute("""UPDATE delivery_state
            SET state = 'delivering', attempts = attempts + 1, last_attempt_at = ?, next_attempt_at = ?, attempt_token = ?
            WHERE delivery_id = ? AND state IN ('queued', 'retryable', 'auth_blocked', 'delivering')
                AND next_attempt_at <= ?
                AND EXISTS (SELECT 1 FROM deliveries WHERE delivery_id = ? AND profile_ref = ?)
                AND NOT EXISTS (SELECT 1 FROM profile_pauses WHERE profile_ref = ? AND paused_until > ?)""",
            (now, now + 1200, token, delivery_id, now, delivery_id, profile_ref, profile_ref, now)).rowcount
        return token if changed else None


def renew_attempt(path: Path, profile_ref: str, delivery_id: str, attempt_token: str) -> bool:
    if not path.exists():
        return False
    with _connect(path) as db:
        return bool(db.execute("""UPDATE delivery_state SET next_attempt_at = ?
            WHERE delivery_id = ? AND state = 'delivering' AND attempt_token = ?
                AND EXISTS (SELECT 1 FROM deliveries WHERE delivery_id = ? AND profile_ref = ?)""",
            (time.time() + 1200, delivery_id, attempt_token, delivery_id, profile_ref)).rowcount)


def finish_attempt(path: Path, profile_ref: str, delivery_id: str, state: str,
                   http_status: int | None, error_code: str | None, *, attempt_token: str) -> str:
    if state not in {"failed", "retryable", "auth_blocked"}:
        raise ValueError("无效的投递结果")
    now = time.time()
    with _connect(path) as db:
        row = db.execute("""SELECT s.state, s.retry_count, s.attempt_token FROM delivery_state s
            JOIN deliveries d USING (delivery_id) WHERE d.delivery_id = ? AND d.profile_ref = ?""",
            (delivery_id, profile_ref)).fetchone()
        if row is None:
            return "delivered"
        if row[0] != "delivering" or row[2] != attempt_token:
            return row[0]
        retries = row[1] + (state == "retryable")
        next_attempt = 0
        if state == "retryable":
            if retries >= 10:
                state = "failed"
            else:
                next_attempt = now + min(300, 5 * 2 ** (retries - 1))
        elif state == "auth_blocked":
            next_attempt = now + 300
            db.execute("""INSERT INTO profile_pauses VALUES (?, ?)
                ON CONFLICT (profile_ref) DO UPDATE SET paused_until = MAX(paused_until, excluded.paused_until)""",
                (profile_ref, next_attempt))
        db.execute("""UPDATE delivery_state SET state = ?, retry_count = ?, next_attempt_at = ?,
            http_status = ?, error_code = ?, attempt_token = NULL
            WHERE delivery_id = ? AND state = 'delivering' AND attempt_token = ?""",
            (state, retries, next_attempt, http_status, error_code, delivery_id, attempt_token))
        return state


def inspect_queue(path: Path, profile_ref: str, delivery_id: str | None = None) -> list[dict]:
    if not path.exists():
        return []
    with _connect(path) as db:
        db.row_factory = sqlite3.Row
        rows = db.execute("""SELECT d.delivery_id, d.profile_ref, d.text, target.session_id,
                s.state, s.created_at, s.attempts, s.last_attempt_at, s.next_attempt_at,
                s.http_status, s.error_code, p.paused_until
            FROM deliveries d JOIN delivery_state s USING (delivery_id)
            LEFT JOIN delivery_sessions target USING (delivery_id)
            LEFT JOIN profile_pauses p USING (profile_ref)
            WHERE d.profile_ref = ? AND (? IS NULL OR d.delivery_id = ?) ORDER BY d.rowid""",
            (profile_ref, delivery_id, delivery_id)).fetchall()
        records = []
        for row in rows:
            record = dict(row)
            record["attachments"] = [dict(file) for file in db.execute("""SELECT attachment_id, name, mime,
                length(content) AS size FROM attachments WHERE delivery_id = ? ORDER BY position""",
                (record["delivery_id"],))]
            records.append(record)
        return records


def retry(path: Path, profile_ref: str, delivery_id: str) -> bool:
    if not path.exists():
        return False
    now = time.time()
    with _connect(path) as db:
        changed = db.execute("""UPDATE delivery_state SET state = 'queued', attempts = 0,
                retry_count = 0, next_attempt_at = ?, attempt_token = NULL
            WHERE delivery_id = ? AND state != 'cancelled'
                AND (state != 'delivering' OR next_attempt_at <= ?)
                AND EXISTS (SELECT 1 FROM deliveries WHERE delivery_id = ? AND profile_ref = ?)""",
            (now, delivery_id, now, delivery_id, profile_ref)).rowcount
        if changed:
            db.execute("DELETE FROM profile_pauses WHERE profile_ref = ?", (profile_ref,))
        return bool(changed)


def cancel(path: Path, profile_ref: str, delivery_id: str) -> bool:
    if not path.exists():
        return False
    with _connect(path) as db:
        return bool(db.execute("""UPDATE delivery_state SET state = 'cancelled', next_attempt_at = 0, attempt_token = NULL
            WHERE delivery_id = ? AND state != 'cancelled'
                AND (state != 'delivering' OR next_attempt_at <= ?)
                AND EXISTS (SELECT 1 FROM deliveries WHERE delivery_id = ? AND profile_ref = ?)""",
            (delivery_id, time.time(), delivery_id, profile_ref)).rowcount)


def attachments(path: Path, delivery_id: str):
    with _connect(path) as db:
        ids = db.execute("SELECT attachment_id FROM attachments WHERE delivery_id = ? ORDER BY position",
                         (delivery_id,)).fetchall()
    for (attachment_id,) in ids:
        with _connect(path) as db:
            row = db.execute("SELECT name, mime, content FROM attachments WHERE attachment_id = ?",
                             (attachment_id,)).fetchone()
        if row is None:
            raise ValueError("附件队列记录不存在")
        name, mime, content = row
        yield {"attachment_id": attachment_id, "name": name, "mime": mime, "size": len(content)}, content


def delivery_session(path: Path, delivery_id: str) -> str | None:
    return delivery_target(path, delivery_id)[0]


def delivery_target(path: Path, delivery_id: str) -> tuple[str | None, dict | None]:
    with _connect(path) as db:
        row = db.execute("""SELECT target.session_id, notice.kind, state.created_at FROM delivery_sessions target
            JOIN delivery_state state USING (delivery_id) LEFT JOIN delivery_notices notice USING (delivery_id)
            WHERE target.delivery_id = ?""", (delivery_id,)).fetchone()
    if row is None:
        return None, None
    session_id, kind, created_at = row
    return session_id, {"kind": kind, "sent_at": int(created_at * 1_000)} if kind else None


def ack(path: Path, delivery_id: str, *, attempt_token: str) -> bool:
    if not path.exists():
        return False
    with _connect(path) as db:
        return bool(db.execute("""DELETE FROM deliveries WHERE delivery_id = ? AND EXISTS (
            SELECT 1 FROM delivery_state WHERE delivery_id = ? AND state = 'delivering' AND attempt_token = ?)""",
            (delivery_id, delivery_id, attempt_token)).rowcount)
