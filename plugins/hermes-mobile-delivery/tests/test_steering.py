"""插话分界来自实际模型请求中的新 Hermes 插话行。"""

from types import SimpleNamespace
import unittest
from unittest.mock import patch

from hermes_mobile_delivery import register


class SteeringHookTest(unittest.TestCase):
    def setUp(self):
        self.hooks = {}
        self.events = []
        modules = {
            f"hermes_mobile_delivery.{module}": SimpleNamespace(**{function: lambda _ctx: None})
            for module, function in (
                ("adapter", "register_platform"),
                ("bark", "register_bark"),
                ("profile", "register_profile_tools"),
            )
        }
        ctx = SimpleNamespace(
            register_hook=self.hooks.__setitem__,
            emit_to_session=lambda *args: self.events.append(args) or True,
        )
        with patch.dict("sys.modules", modules):
            register(ctx)

    def request(self, request_id, history, messages, *, turn_id="turn"):
        self.assertIn("pre_api_request", self.hooks)
        self.hooks["pre_api_request"](
            session_id="session", turn_id=turn_id, api_request_id=request_id,
            conversation_history=history, request_messages=messages,
        )

    def test_reports_each_new_included_steer_once_for_the_running_turn(self):
        prompt = {"role": "user", "content": "制作动画"}
        correction = {"role": "user", "display_kind": "steer", "content": "不对，不是 svg 是 gif"}
        wire = {"role": "user", "content": [{"type": "input_text", "text": correction["content"]}]}
        self.request("api-1", [prompt], [prompt])
        self.request("api-2", [prompt, correction], [prompt])
        self.assertEqual(self.events, [], "只出现在内部历史的插话还没有进入请求")
        self.request("api-3", [prompt, correction], [prompt, wire])
        self.request("api-3", [prompt, correction], [prompt, wire])
        persisted = {**correction, "message_uid": "first-correction"}
        self.request("api-4", [prompt, persisted], [prompt, wire])
        self.request("api-5", [prompt, persisted, correction], [prompt, wire, wire])
        self.assertEqual(self.events, [
            ("session", "steering.applied", {"api_request_id": "api-3"}),
            ("session", "steering.applied", {"api_request_id": "api-5"}),
        ])

    def test_ordinary_user_messages_and_previous_turn_history_do_not_split(self):
        previous = {"role": "user", "display_kind": "steer", "content": "改用 GIF"}
        user = {"role": "user", "content": "改用 GIF"}
        self.request("api-1", [previous, user], [user], turn_id="next")
        self.request("api-2", [previous, user], [previous, user], turn_id="next")
        self.request("api-3", [previous, user, user], [previous, user, user], turn_id="next")
        self.assertEqual(self.events, [])

    def test_merged_provider_user_messages_keep_each_steer_block_detectable(self):
        prompt = {"role": "user", "content": "制作动画"}
        first = {"role": "user", "display_kind": "steer", "content": "改用 GIF"}
        second = {"role": "user", "display_kind": "steer", "content": "保留透明背景"}
        for provider, blocks in (
            ("anthropic", [{"type": "tool_result", "content": "tool"},
                           {"type": "text", "text": first["content"]},
                           {"type": "text", "text": second["content"]}]),
            ("bedrock", [{"toolResult": {"content": [{"text": "tool"}]}},
                         {"text": first["content"]}, {"text": second["content"]}]),
        ):
            with self.subTest(provider=provider):
                self.events.clear()
                self.request("api-1", [prompt], [prompt], turn_id=provider)
                wire = {"role": "user", "content": blocks}
                self.request("api-2", [prompt, first, second], [prompt, wire], turn_id=provider)
                self.assertEqual(self.events, [("session", "steering.applied", {"api_request_id": "api-2"})])

    def test_new_identical_steer_is_detected_when_compaction_removed_the_old_row(self):
        prompt = {"role": "user", "content": "制作动图"}
        old = {"role": "user", "display_kind": "steer", "content": "改用 GIF", "message_uid": "old-row"}
        new = {**old, "message_uid": "new-row"}
        self.request("api-1", [old, prompt], [old, prompt])
        self.request("api-2", [prompt, new], [prompt, new])
        self.request("api-3", [prompt, new], [prompt, new])
        self.assertEqual(self.events, [("session", "steering.applied", {"api_request_id": "api-2"})])

    def test_tracks_a_steer_that_gains_its_uid_before_context_removes_it(self):
        prompt = {"role": "user", "content": "制作动图"}
        old = {"role": "user", "display_kind": "steer", "content": "改用 GIF"}
        new = old.copy()
        self.request("api-1", [prompt], [prompt])
        self.request("api-2", [prompt, old], [prompt, old])
        old["message_uid"] = "first-durable-row"
        self.request("api-3", [prompt, new], [prompt, new])
        self.assertEqual(self.events, [
            ("session", "steering.applied", {"api_request_id": "api-2"}),
            ("session", "steering.applied", {"api_request_id": "api-3"}),
        ])
