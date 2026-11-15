import argparse
import asyncio
from contextlib import redirect_stdout
import importlib
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
from tempfile import TemporaryDirectory
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

from hermes_mobile_delivery.spool import attachments, begin_attempt, enqueue, finish_attempt, pull


class AdapterTest(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "queue.sqlite3"
        self.source = Path(directory.name) / "sample.png"
        self.source.write_bytes(b"image bytes")
        environment = {"HERMES_MOBILE_HOME_CHANNEL": "1", "HERMES_MOBILE_PROFILE": "default",
                       "HERMES_MOBILE_INBOX_URL": "http://127.0.0.1:1/internal/inbox/v1/deliveries",
                       "HERMES_MOBILE_INBOX_TOKEN": "test-token", "HERMES_MOBILE_SPOOL_PATH": str(self.path)}
        self.env = patch.dict(os.environ, environment)
        self.env.start()
        self.addCleanup(self.env.stop)

        class Base:
            def __init__(self, config, platform):
                pass

            @staticmethod
            def validate_media_delivery_path(value):
                return None if Path(value).name == "secret.txt" else str(Path(value).resolve())

        exports = {
            "agent.redact": {"redact_sensitive_text": lambda text, **kwargs: text},
            "gateway.config": {"Platform": str},
            "gateway.platform_registry": {"PlatformEntry": SimpleNamespace(__dataclass_fields__={})},
            "gateway.platforms.base": {"BasePlatformAdapter": Base, "SendResult": SimpleNamespace},
            "hermes_cli.config": {"get_env_value_prefer_dotenv": os.environ.get},
            "hermes_constants": {"get_hermes_home": lambda: Path(directory.name)},
        }
        modules = {}
        for name, attributes in exports.items():
            module = ModuleType(name)
            module.__dict__.update(attributes)
            modules[name] = module
        with patch.dict(sys.modules, modules):
            sys.modules.pop("hermes_mobile_delivery.adapter", None)
            self.module = importlib.import_module("hermes_mobile_delivery.adapter")
        self.addCleanup(sys.modules.pop, "hermes_mobile_delivery.adapter", None)
        self.platform = {}
        self.commands = {}
        self.module.register_platform(SimpleNamespace(profile_name="default",
            register_platform=lambda **kwargs: self.platform.update(kwargs),
            register_cli_command=lambda **kwargs: self.commands.update({kwargs["name"]: kwargs})))
        self.cli = self.commands["mobile-send"]
        self.adapter = self.platform["adapter_factory"](None)

    def run_queue(self, arguments):
        command = self.commands.get("mobile-queue")
        self.assertIsNotNone(command, "queue inspection and recovery command must be registered")
        parser = argparse.ArgumentParser()
        command["setup_fn"](parser)
        output = io.StringIO()
        with redirect_stdout(output), self.assertRaises(SystemExit) as raised:
            command["handler_fn"](parser.parse_args(arguments))
        return raised.exception.code, json.loads(output.getvalue())

    def test_reports_queued_and_terminal_status_without_treating_status_strings_as_delivery(self):
        queued = asyncio.run(self.adapter.send("1", "后台消息"))
        self.assertEqual(queued.raw_response.get("delivery_status"), "queued")
        for status in ("delivered", "retryable", "failed", "auth_blocked"):
            with self.subTest(status=status), patch.object(self.module, "deliver_one", return_value=status):
                result = asyncio.run(self.platform["standalone_sender_fn"](None, "mobile_target", "消息"))
            self.assertEqual(result.get("delivery_status"), status)
            self.assertEqual(result["success"], status != "failed")
            self.assertEqual("note" in result, status != "delivered")
            self.assertEqual("error" in result, status == "failed")
            self.assertTrue(result["message_id"])

    def test_queue_cli_lists_cancels_and_retries_without_changing_target_or_files(self):
        delivery_id = enqueue(self.path, "default", "报告", [(self.source, None)], session_id="mobile_target")
        foreign_id = enqueue(self.path, "other", "其他档案")
        attempt_token = begin_attempt(self.path, "default", delivery_id)
        self.assertTrue(attempt_token)
        finish_attempt(self.path, "default", delivery_id, "failed", 422, "VALIDATION_FAILED",
                       attempt_token=attempt_token)
        self.source.unlink()
        exit_code, result = self.run_queue(["list"])
        self.assertEqual(exit_code, 0)
        self.assertEqual([item["delivery_id"] for item in result["deliveries"]], [delivery_id])
        self.assertEqual(result["deliveries"][0]["session_id"], "mobile_target")
        self.assertEqual(result["deliveries"][0]["text"], "报告")
        self.assertEqual(result["deliveries"][0]["state"], "failed")
        self.assertEqual(result["deliveries"][0]["error_code"], "VALIDATION_FAILED")
        original = list(attachments(self.path, delivery_id))
        exit_code, result = self.run_queue(["retry", delivery_id])
        self.assertEqual(exit_code, 0)
        self.assertEqual(result["deliveries"][0]["state"], "queued")
        self.assertEqual(result["deliveries"][0]["session_id"], "mobile_target")
        self.assertEqual(list(attachments(self.path, delivery_id)), original)
        exit_code, result = self.run_queue(["cancel", delivery_id])
        self.assertEqual(exit_code, 0)
        self.assertEqual(result["deliveries"][0]["state"], "cancelled")
        self.assertEqual(list(attachments(self.path, delivery_id)), original)
        self.assertEqual(self.run_queue(["retry", delivery_id])[0], 1)
        self.assertEqual(self.run_queue(["cancel", foreign_id])[0], 1)
        self.assertEqual(self.run_queue(["list", "--id", foreign_id])[1]["deliveries"], [])

    def test_queue_cli_rejects_invalid_configuration(self):
        with patch.dict(os.environ, {"HERMES_MOBILE_PROFILE": "other"}):
            exit_code, result = self.run_queue(["list"])
        self.assertEqual(exit_code, 1)
        self.assertIn("error", result)

    def test_native_media_signatures_queue_files_without_text_and_preserve_caption_and_name(self):
        calls = [
            ("send_image_file", {"image_path": str(self.source)}),
            ("send_document", {"file_path": str(self.source), "file_name": "图表.png", "caption": "说明"}),
            ("send_video", {"video_path": str(self.source)}),
            ("send_voice", {"audio_path": str(self.source)}),
            ("send_image", {"image_url": self.source.as_uri()}),
            ("send_animation", {"animation_url": self.source.as_uri()}),
        ]
        for method, kwargs in calls:
            with self.subTest(method=method):
                result = asyncio.run(getattr(self.adapter, method)(chat_id="1", **kwargs))
                self.assertTrue(result.success, result.error)
                reference, content = next(attachments(self.path, result.message_id))
                self.assertEqual(reference["name"], kwargs.get("file_name", "sample.png"))
                self.assertEqual(reference["mime"], "image/png")
                self.assertEqual(content, b"image bytes")
                self.assertIn((result.message_id, kwargs.get("caption", "")), pull(self.path, "default"))

    def test_standalone_media_is_durably_accepted_when_server_is_unavailable(self):
        with patch.object(self.module, "deliver_one", return_value="retryable"):
            result = asyncio.run(self.platform["standalone_sender_fn"](
                None, "1", "", media_files=[(str(self.source), False)]))
        self.assertTrue(result.get("success"), result)
        self.assertIn("note", result)
        self.source.unlink()
        self.assertEqual(next(attachments(self.path, result["message_id"]))[1], b"image bytes")

    def test_gateway_send_uses_hermes_media_extraction_for_scheduled_reports(self):
        with patch.object(self.module.BasePlatformAdapter, "extract_media",
                          return_value=([(str(self.source), False)], "日报"), create=True):
            result = asyncio.run(self.adapter.send("1", f"日报\nMEDIA:{self.source}"))
        self.assertTrue(result.success, result.error)
        self.assertEqual(pull(self.path, "default"), [(result.message_id, "日报")])
        self.assertEqual(next(attachments(self.path, result.message_id))[1], b"image bytes")

    def test_rejects_remote_urls_unsafe_paths_and_unsupported_threads_without_queueing(self):
        secret = self.source.with_name("secret.txt")
        secret.write_text("secret")
        link = self.source.with_name("link.png")
        link.symlink_to(self.source)
        calls = [
            self.adapter.send_image("1", "https://127.0.0.1/private.png"),
            self.adapter.send_image_file("1", str(link)),
            self.adapter.send_document("1", str(secret)),
            self.adapter.send_document("1", str(self.source), metadata={"thread_id": "42"}),
        ]
        for call in calls:
            result = asyncio.run(call)
            self.assertFalse(result.success)
        self.assertEqual(pull(self.path, "default"), [])

    def test_mobile_send_cli_supports_multiple_files_on_older_hermes(self):
        self.assertEqual(self.cli.get("name"), "mobile-send")
        parser = argparse.ArgumentParser()
        self.cli["setup_fn"](parser)
        args = parser.parse_args(["说明", "--file", str(self.source), "--file", str(self.source)])
        output = io.StringIO()
        with patch.object(self.module, "deliver_one", return_value="retryable"), redirect_stdout(output):
            with self.assertRaises(SystemExit) as raised:
                self.cli["handler_fn"](args)
        self.assertEqual(raised.exception.code, 0)
        result = json.loads(output.getvalue())
        self.assertTrue(result["success"])
        self.assertEqual(len(list(attachments(self.path, result["message_id"]))), 2)

    def test_native_targeted_media_and_text_keep_session_target(self):
        session = "mobile_session-1"
        results = [asyncio.run(self.adapter.send(session, "会话消息")),
                   asyncio.run(self.adapter.send_document(session, str(self.source)))]
        with patch.object(self.module, "deliver_one", return_value="retryable"):
            results.append(SimpleNamespace(**asyncio.run(self.platform["standalone_sender_fn"](
                None, session, "独立投递"))))
        for result in results:
            self.assertTrue(result.success)
            with sqlite3.connect(self.path) as db:
                target = db.execute("SELECT session_id FROM delivery_sessions WHERE delivery_id = ?",
                                    (result.message_id,)).fetchone()
            self.assertEqual(target, (session,))

    def test_registers_native_session_target_parsers_when_supported_by_hermes(self):
        fields = {"parse_target_ref_fn": None, "target_ref_syntax_fn": None}
        with patch.object(self.module.PlatformEntry, "__dataclass_fields__", fields):
            self.module.register_platform(SimpleNamespace(profile_name="default",
                register_platform=lambda **kwargs: self.platform.update(kwargs),
                register_cli_command=lambda **kwargs: self.cli.update(kwargs)))
        for name in fields:
            parser = self.platform.get(name)
            self.assertIsNotNone(parser)
            self.assertEqual(parser("mobile_session-1"), ("mobile_session-1", None))
            self.assertEqual(parser("1"), ("1", None))
            self.assertIsNone(parser("mobile_session:thread"))
            self.assertIsNone(parser("../secret"))

    def test_mobile_send_cli_defaults_to_current_mobile_session_and_honors_explicit_inbox(self):
        parser = argparse.ArgumentParser()
        self.cli["setup_fn"](parser)
        cases = [
            ({}, [], None),
            ({"HERMES_SESSION_PLATFORM": "api_server", "HERMES_SESSION_CHAT_ID": "mobile_here"}, [], "mobile_here"),
            ({"HERMES_SESSION_PLATFORM": "api_server", "HERMES_SESSION_CHAT_ID": "another_session"}, [], None),
            ({"HERMES_SESSION_PLATFORM": "telegram", "HERMES_SESSION_CHAT_ID": "mobile_here"}, [], None),
            ({"HERMES_SESSION_PLATFORM": "api_server", "HERMES_SESSION_CHAT_ID": "mobile_here", "HERMES_CRON_SESSION": "1"}, [], None),
            ({"HERMES_SESSION_PLATFORM": "api_server", "HERMES_SESSION_CHAT_ID": "mobile_here", "HERMES_SESSION_PROFILE": "other"}, [], None),
            ({"HERMES_SESSION_PLATFORM": "api_server", "HERMES_SESSION_CHAT_ID": "mobile_here"}, ["--to", "hermes_mobile"], None),
            ({}, ["--to", "hermes_mobile:mobile_elsewhere"], "mobile_elsewhere"),
        ]
        for environment, target, expected in cases:
            with self.subTest(environment=environment, target=target):
                context = {"HERMES_SESSION_PLATFORM": "", "HERMES_SESSION_CHAT_ID": "", "HERMES_SESSION_PROFILE": "",
                           "HERMES_CRON_SESSION": "", **environment}
                args = parser.parse_args(["--file", str(self.source), *target])
                output = io.StringIO()
                with patch.dict(os.environ, context), patch.object(self.module, "deliver_one", return_value="retryable"), redirect_stdout(output):
                    with self.assertRaises(SystemExit) as raised:
                        self.cli["handler_fn"](args)
                self.assertEqual(raised.exception.code, 0)
                result = json.loads(output.getvalue())
                with sqlite3.connect(self.path) as db:
                    row = db.execute("SELECT session_id FROM delivery_sessions WHERE delivery_id = ?",
                                     (result["message_id"],)).fetchone()
                self.assertEqual(row[0] if row else None, expected)

    def test_rejects_invalid_session_targets_without_queueing(self):
        for target in ("", "has space", "has:thread", "../path", "line\nfeed", "x" * 513):
            with self.subTest(target=target):
                result = asyncio.run(self.adapter.send(target, "消息"))
                self.assertFalse(result.success)
        self.assertEqual(pull(self.path, "default"), [])

    def test_cli_rejects_empty_foreign_and_thread_targets_without_queueing(self):
        parser = argparse.ArgumentParser()
        self.cli["setup_fn"](parser)
        for target in ("hermes_mobile:", "telegram:mobile_session", "hermes_mobile:mobile_session:thread", "mobile_session"):
            with self.subTest(target=target), redirect_stdout(io.StringIO()):
                args = parser.parse_args(["--file", str(self.source), "--to", target])
                with self.assertRaises(SystemExit) as raised:
                    self.cli["handler_fn"](args)
                self.assertEqual(raised.exception.code, 1)
        self.assertEqual(pull(self.path, "default"), [])
