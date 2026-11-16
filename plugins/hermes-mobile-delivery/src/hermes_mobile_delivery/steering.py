"""用 Hermes 会话事件标出插话进入模型请求的位置。"""

from collections import Counter, OrderedDict, defaultdict
from dataclasses import dataclass, field
from hashlib import sha256
from threading import Lock


def _user_text_blocks(message):
    if not isinstance(message, dict) or message.get("role") != "user":
        return
    content = message.get("content")
    if isinstance(content, str):
        yield content.strip()
    elif isinstance(content, list):
        # 一条提供商消息可能合并了工具结果与多个相邻的用户文本块。
        for part in content:
            if (isinstance(part, dict) and part.get("type") in (None, "text", "input_text")
                    and isinstance(part.get("text"), str)):
                yield part["text"].strip()


def _uid(row):
    value = row.get("message_uid")
    return value if isinstance(value, str) and value else None


@dataclass
class _SeenSteers:
    uids: set[str] = field(default_factory=set)
    unassigned: int = 0
    pending_rows: list[dict] = field(default_factory=list)

    def observe(self, rows):
        # Hermes 写入 UID 时会更新原行。即使压缩已从历史移除这行，也能识别下一个同文插话。
        promoted = {uid for row in self.pending_rows if (uid := _uid(row)) is not None} - self.uids
        self.uids.update(promoted)
        unassigned = max(0, self.unassigned - len(promoted))
        named = {uid for row in rows if (uid := _uid(row)) is not None}
        unnamed = [row for row in rows if _uid(row) is None]
        new_uids = len(named - self.uids)
        self.uids.update(named)
        # 独立插件进程收到的是行副本。使用未命名行的数量对账随后出现的 UID。
        self.unassigned = max(len(unnamed), unassigned - new_uids)
        self.pending_rows = unnamed[-16:] or [row for row in self.pending_rows if _uid(row) is None][:self.unassigned]
        return new_uids + len(unnamed) > unassigned


def register_steering_events(ctx):
    emit = getattr(ctx, "emit_to_session", None)
    if not callable(emit) or not callable(getattr(ctx, "register_hook", None)):
        return

    seen_by_turn: OrderedDict[str, dict[bytes, _SeenSteers]] = OrderedDict()
    lock = Lock()

    def before_request(*, session_id=None, turn_id=None, api_request_id=None,
                       conversation_history=None, request_messages=None, **_kwargs):
        if not all(isinstance(value, str) and 0 < len(value) <= 512
                   for value in (session_id, turn_id, api_request_id)):
            return
        if not isinstance(conversation_history, list) or not isinstance(request_messages, list):
            return
        # 原始历史中的 display_kind 由 Hermes 标记。模型请求的序列化可能移除该字段。
        candidates: dict[str, list[dict]] = defaultdict(list)
        for row in conversation_history:
            if not isinstance(row, dict) or row.get("display_kind") != "steer":
                continue
            for text in _user_text_blocks(row):
                if text:
                    candidates[text].append(row)
        included = Counter(
            text for row in request_messages for text in _user_text_blocks(row) if text in candidates
        ) if candidates else Counter()

        applied = False
        with lock:
            previous = seen_by_turn.pop(turn_id, None)
            seen = previous or {}
            for text, rows in candidates.items():
                # 首个请求建立基线，历史插话随上下文重发时不产生新分界。
                current = rows if previous is None else rows[:included[text]]
                if not current:
                    continue
                digest = sha256(text.encode(errors="surrogatepass")).digest()
                observed = seen.get(digest)
                if observed is None:
                    observed = seen[digest] = _SeenSteers()
                applied |= observed.observe(current)
            seen_by_turn[turn_id] = seen
            if len(seen_by_turn) > 128:
                seen_by_turn.popitem(last=False)

        if previous is not None and applied:
            # 同一请求吸收的多条插话共用一次分界。会话事件可随回复增量回放。
            emit(session_id, "steering.applied", {"api_request_id": api_request_id})

    ctx.register_hook("pre_api_request", before_request)

    def forget_turn(*, turn_id=None, **_kwargs):
        if isinstance(turn_id, str):
            with lock:
                seen_by_turn.pop(turn_id, None)

    ctx.register_hook("on_session_end", forget_turn)
