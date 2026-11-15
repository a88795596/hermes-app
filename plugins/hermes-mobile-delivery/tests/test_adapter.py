import argparse
import asyncio
from contextlib import redirect_stdout
import importlib
import io
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

from hermes_mobile_delivery.spool import attachments, pull


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
        self.cli = {}
        self.module.register_platform(SimpleNamespace(profile_name="default",
            register_platform=lambda **kwargs: self.platform.update(kwargs),
            register_cli_command=lambda **kwargs: self.cli.update(kwargs)))
        self.adapter = self.platform["adapter_factory"](None)

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
        with patch.object(self.module, "deliver_one", return_value=False):
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
        with patch.object(self.module, "deliver_one", return_value=False), redirect_stdout(output):
            with self.assertRaises(SystemExit) as raised:
                self.cli["handler_fn"](args)
        self.assertEqual(raised.exception.code, 0)
        result = json.loads(output.getvalue())
        self.assertTrue(result["success"])
        self.assertEqual(len(list(attachments(self.path, result["message_id"]))), 2)
