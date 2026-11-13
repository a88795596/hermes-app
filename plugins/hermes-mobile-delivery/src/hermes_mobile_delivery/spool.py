"""持久化投递队列，供 Hermes 连接器通过命令行拉取并确认。"""

import argparse
from contextlib import closing, contextmanager
from pathlib import Path
import json
import os
import sqlite3
import stat
from uuid import UUID, uuid4


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
        db.execute("""CREATE TABLE IF NOT EXISTS deliveries (
            delivery_id TEXT PRIMARY KEY,
            profile_ref TEXT NOT NULL,
            text TEXT NOT NULL
        )""")
        yield db


def enqueue(path: Path, profile_ref: str, text: str) -> str:
    delivery_id = str(uuid4())
    with _connect(path) as db:
        db.execute("INSERT INTO deliveries VALUES (?, ?, ?)", (delivery_id, profile_ref, text))
    return delivery_id


def pull(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with _connect(path) as db:
        rows = db.execute("SELECT delivery_id, profile_ref, text FROM deliveries ORDER BY rowid LIMIT 20").fetchall()
    return [
        {"type": "delivery", "event_id": delivery_id, "delivery_id": delivery_id, "profile_ref": profile_ref, "text": text}
        for delivery_id, profile_ref, text in rows
    ]


def ack(path: Path, delivery_id: str) -> None:
    if str(UUID(delivery_id)) != delivery_id:
        raise ValueError("投递 ID 无效")
    if path.exists():
        with _connect(path) as db:
            db.execute("DELETE FROM deliveries WHERE delivery_id = ?", (delivery_id,))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path, help="本地投递队列的绝对路径")
    commands = parser.add_subparsers(dest="command", required=True, title="队列命令")
    commands.add_parser("pull", help="读取待投递的记录")
    acknowledge = commands.add_parser("ack", help="确认已投递的记录")
    acknowledge.add_argument("delivery_id", help="已投递记录的 ID")
    args = parser.parse_args()
    if args.command == "pull":
        print(json.dumps(pull(args.path)))
    else:
        ack(args.path, args.delivery_id)


if __name__ == "__main__":
    main()
