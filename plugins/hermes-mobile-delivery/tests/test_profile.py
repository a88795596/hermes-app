import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from threading import Thread
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch


PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")


class ProfileAvatarTest(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)
        self.image = self.directory / "avatar.png"
        self.image.write_bytes(PNG)
        self.requests = []
        self.status = 200
        self.receipt = {"data": {"profile_id": "profile-work", "label": "work",
                                 "avatar_url": "/mobile/v1/profiles/profile-work/avatar?v=123"}}
        test = self

        class Handler(BaseHTTPRequestHandler):
            def do_PUT(self):
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                test.requests.append((self.path, self.headers["Authorization"], payload))
                self.send_response(test.status)
                self.end_headers()
                self.wfile.write(json.dumps(test.receipt).encode())

            def log_message(self, *_):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        environment = {"HERMES_MOBILE_INBOX_URL": f"http://127.0.0.1:{server.server_port}/internal/inbox/v1/deliveries",
                       "HERMES_MOBILE_INBOX_TOKEN": "test-token", "HERMES_MOBILE_PROFILE": "default"}
        env = patch.dict(os.environ, environment)
        env.start()
        self.addCleanup(env.stop)

        class Base:
            @staticmethod
            def validate_media_delivery_path(value):
                return None if Path(value).name == "secret.png" else str(Path(value).resolve())

        modules = {}
        for name, exports in {
            "gateway.platforms.base": {"BasePlatformAdapter": Base},
            "hermes_cli.config": {"get_env_value_prefer_dotenv": os.environ.get},
        }.items():
            module = ModuleType(name)
            module.__dict__.update(exports)
            modules[name] = module
        with patch.dict(sys.modules, modules):
            sys.modules.pop("hermes_mobile_delivery.profile", None)
            self.module = importlib.import_module("hermes_mobile_delivery.profile")
        self.addCleanup(sys.modules.pop, "hermes_mobile_delivery.profile", None)

    def call(self, **changes):
        return json.loads(self.module.set_profile_avatar({"profile_ref": "work", "image_path": str(self.image), **changes}))

    def test_registers_native_tool_and_uploads_to_specified_allowed_profile(self):
        registered = {}
        self.module.register_profile_tools(SimpleNamespace(register_tool=lambda **kwargs: registered.update(kwargs)))
        self.assertEqual(registered["name"], "hermes_mobile_set_profile_avatar")
        self.assertTrue(registered["check_fn"]())
        self.assertEqual(registered["schema"]["parameters"]["required"], ["profile_ref", "image_path"])
        result = self.call()
        self.assertEqual(result, {"success": True, "profile_ref": "work", "profile_id": "profile-work",
                                  "avatar_url": self.receipt["data"]["avatar_url"]})
        self.assertEqual(self.requests, [("/internal/profiles/v1/avatar", "Bearer test-token", {
            "profile_ref": "work", "avatar": {"name": "avatar.png", "mime": "image/png", "size": len(PNG),
                                                 "content_base64": base64.b64encode(PNG).decode("ascii")}})])

    def test_rejects_invalid_inputs_paths_symlinks_and_oversized_files_without_request(self):
        secret = self.directory / "secret.png"
        secret.write_bytes(PNG)
        symlink = self.directory / "linked.png"
        symlink.symlink_to(self.image)
        huge = self.directory / "huge.png"
        with huge.open("wb") as file:
            file.truncate(self.module.MAX_AVATAR_BYTES + 1)
        empty = self.directory / "empty.png"
        empty.touch()
        fake = self.directory / "fake.png"
        fake.write_text("not an image")
        for path in (secret, symlink, huge, empty, fake, self.directory, self.directory / "missing.png",
                     "https://private.example/avatar.png", "bad\x00path", 3):
            with self.subTest(path=path):
                self.assertFalse(self.call(image_path=str(path) if isinstance(path, Path) else path)["success"])
        for profile in (None, 3, "", " work", "a" * 65, "bad\nprofile", "\ud800"):
            with self.subTest(profile=profile):
                self.assertFalse(self.call(profile_ref=profile)["success"])
        self.assertFalse(json.loads(self.module.set_profile_avatar({}))["success"])
        self.assertFalse(json.loads(self.module.set_profile_avatar(None))["success"])
        self.assertEqual(self.requests, [])

    def test_reads_mime_from_content_and_rejects_bad_configuration(self):
        for content, mime in ((b"\xff\xd8\xff" + b"jpeg", "image/jpeg"),
                              (b"GIF89a" + b"gif", "image/gif"),
                              (b"RIFF1234WEBP" + b"webp", "image/webp")):
            self.image.write_bytes(content)
            self.assertTrue(self.call()["success"])
            self.assertEqual(self.requests[-1][2]["avatar"]["mime"], mime)
        count = len(self.requests)
        for key, value in (("HERMES_MOBILE_INBOX_URL", "https://user:secret@example.com/"),
                           ("HERMES_MOBILE_INBOX_TOKEN", "bad token")):
            with patch.dict(os.environ, {key: value}):
                self.assertFalse(self.call()["success"])
        self.assertEqual(len(self.requests), count)

    def test_failures_and_invalid_receipts_never_claim_success(self):
        with patch("hermes_mobile_delivery.inbox.sleep"):
            for status in (401, 403, 404, 422, 503):
                self.status = status
                self.receipt = {"error": {"message": "test-token must not leak"}}
                result = self.call()
                self.assertFalse(result["success"])
                self.assertEqual(result["http_status"], status)
                self.assertNotIn("test-token", json.dumps(result))
        self.status = 200
        for receipt in ({}, [], {"data": {}}, {"data": {"profile_id": "x", "label": "work"}},
                        {"data": {"profile_id": "x", "label": "default", "avatar_url": "/avatar.png"}}):
            self.receipt = receipt
            self.assertFalse(self.call()["success"])
        for response in ((None, b""), (200, b"invalid json")):
            with patch.object(self.module, "_request", return_value=response):
                self.assertFalse(self.call()["success"])


if __name__ == "__main__":
    unittest.main()
