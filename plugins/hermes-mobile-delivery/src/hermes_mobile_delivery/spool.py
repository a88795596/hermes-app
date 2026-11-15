"""Hermes 插件私有的持久化投递队列。"""

from contextlib import closing, contextmanager
import mimetypes
from pathlib import Path
import os
import sqlite3
import stat
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
        db.execute("""CREATE TABLE IF NOT EXISTS attachments (
            attachment_id TEXT PRIMARY KEY,
            delivery_id TEXT NOT NULL REFERENCES deliveries(delivery_id) ON DELETE CASCADE,
            position INTEGER NOT NULL,
            name TEXT NOT NULL,
            mime TEXT NOT NULL,
            content BLOB NOT NULL
        )""")
        yield db


def enqueue(path: Path, profile_ref: str, text: str, files=()) -> str:
    if len(files) > MAX_ATTACHMENTS:
        raise ValueError("每条消息最多包含 10 个附件")
    delivery_id = str(uuid4())
    with _connect(path) as db:
        db.execute("INSERT INTO deliveries VALUES (?, ?, ?)", (delivery_id, profile_ref, text))
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


def ack(path: Path, delivery_id: str) -> None:
    if path.exists():
        with _connect(path) as db:
            db.execute("DELETE FROM deliveries WHERE delivery_id = ?", (delivery_id,))
