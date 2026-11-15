from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import base64
import json
import os
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
from threading import Thread
import unittest
from uuid import uuid4
from unittest.mock import patch

from hermes_mobile_delivery.inbox import deliver_pending, inbox_endpoint, post_delivery
from hermes_mobile_delivery.spool import enqueue, pull


class InboxDeliveryTest(unittest.TestCase):
    def setUp(self):
        timer = patch("hermes_mobile_delivery.spool.time.time", return_value=1000)
        self.clock = timer.start()
        self.addCleanup(timer.stop)
        self.requests = []
        self.uploads = []
        self.upload_status = 200
        self.upload_mime = None
        self.corrupt_upload_receipt = False
        self.responses = iter(())
        test = self

        class Handler(BaseHTTPRequestHandler):
            def do_PUT(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                test.uploads.append((self.path, self.headers["Authorization"], body))
                self.send_response(test.upload_status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                receipt = {key: body[key] for key in ("name", "mime", "size")}
                receipt["attachment_id"] = self.path.rsplit("/", 1)[1]
                if test.upload_mime is not None:
                    receipt["mime"] = test.upload_mime
                if test.corrupt_upload_receipt:
                    receipt["size"] += 1
                self.wfile.write(json.dumps({"data": receipt}).encode())

            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                test.requests.append((self.path, self.headers["Authorization"], json.loads(body)))
                status = next(test.responses)
                if status is None:
                    return
                self.send_response(status)
                if status == 307:
                    self.send_header("Location", "/another-service")
                self.end_headers()

            def log_message(self, *_):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.endpoint = inbox_endpoint(f"http://127.0.0.1:{server.server_port}/internal/inbox/v1/deliveries")
        self.delivery_id = str(uuid4())

    def send(self):
        return post_delivery(self.endpoint, "inbox-token", self.delivery_id, "work", "早报完成")[0]

    def test_retries_with_same_delivery_id_after_connection_loss(self):
        self.responses = iter([None, 503, 204])
        self.assertEqual(self.send(), 204)
        expected = ("/internal/inbox/v1/deliveries", "Bearer inbox-token", {
            "delivery_id": self.delivery_id, "profile_ref": "work", "text": "早报完成",
        })
        self.assertEqual(self.requests, [expected] * 3)

    def test_does_not_follow_redirect_or_retry_rejected_credentials(self):
        for status in (307, 401):
            with self.subTest(status=status):
                self.requests.clear()
                self.responses = iter([status, 204])
                self.assertEqual(self.send(), status)
                self.assertEqual(len(self.requests), 1)

    def test_endpoint_accepts_private_network_and_rejects_embedded_credentials(self):
        self.assertIsNotNone(inbox_endpoint("http://bff:4317/internal/inbox/v1/deliveries"))
        for url in ("https://user:token@bff/", "http://bff:invalid/", "file:///tmp/message", "https://bff/?token=secret"):
            with self.subTest(url=url):
                self.assertIsNone(inbox_endpoint(url))

    def test_persists_delivery_until_http_receipt_and_drains_only_its_profile(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "queue.sqlite3"
            another_id = enqueue(path, "other", "其他配置档案")
            delivery_id = enqueue(path, "work", "服务离线时产生的消息")
            self.responses = iter([503, 503, 503])
            with self.assertLogs("hermes_mobile_delivery.inbox", level="WARNING"):
                self.assertFalse(deliver_pending(path, self.endpoint, "inbox-token", "work"))
            self.assertEqual(pull(path, "work"), [(delivery_id, "服务离线时产生的消息")])

            self.clock.return_value += 300
            self.responses = iter([204])
            self.assertTrue(deliver_pending(path, self.endpoint, "inbox-token", "work"))
            self.assertEqual([request[2]["delivery_id"] for request in self.requests], [delivery_id] * 4)
            self.assertEqual(pull(path, "work"), [])
            self.assertEqual(pull(path, "other"), [(another_id, "其他配置档案")])

    def test_retries_file_only_delivery_from_snapshot_after_source_is_deleted(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "queue.sqlite3"
            source = Path(directory) / "报告.md"
            source.write_bytes(b"# Saved report\n")
            delivery_id = enqueue(path, "work", "", [(source, None)])
            source.unlink()
            self.responses = iter([503, 503, 503])
            with self.assertLogs("hermes_mobile_delivery.inbox", level="WARNING"):
                self.assertFalse(deliver_pending(path, self.endpoint, "inbox-token", "work"))
            self.assertEqual(pull(path, "work"), [(delivery_id, "")])
            self.clock.return_value += 300
            self.responses = iter([204])
            self.assertTrue(deliver_pending(path, self.endpoint, "inbox-token", "work"))
            self.assertEqual(pull(path, "work"), [])
            self.assertEqual(self.uploads[0], self.uploads[1])
            upload_path, token, upload = self.uploads[0]
            self.assertEqual(token, "Bearer inbox-token")
            self.assertTrue(upload_path.startswith("/internal/attachments/v1/"))
            self.assertEqual(upload, {"profile_ref": "work", "name": "报告.md", "mime": "text/markdown",
                                      "size": 15, "content_base64": base64.b64encode(b"# Saved report\n").decode()})
            self.assertEqual(self.requests[-1][2], {"delivery_id": delivery_id, "profile_ref": "work", "text": "",
                "attachments": [{"attachment_id": upload_path.rsplit("/", 1)[1], "name": "报告.md",
                                 "mime": "text/markdown", "size": 15}]})
            with sqlite3.connect(path) as db:
                self.assertEqual(db.execute("SELECT COUNT(*) FROM attachments").fetchone()[0], 0)

    def test_session_target_survives_file_retry_and_legacy_queue_stays_inbox(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "queue.sqlite3"
            with sqlite3.connect(path) as db:
                db.execute("CREATE TABLE deliveries (delivery_id TEXT PRIMARY KEY, profile_ref TEXT NOT NULL, text TEXT NOT NULL)")
                db.execute("INSERT INTO deliveries VALUES (?, ?, ?)", (self.delivery_id, "work", "旧消息"))
            path.chmod(0o600)
            source = Path(directory) / "report.md"
            source.write_bytes(b"# Report")
            targeted_id = enqueue(path, "work", "", [(source, None)], session_id="mobile_session-1")
            source.unlink()
            self.responses = iter([204, 503, 503, 503])
            with self.assertLogs("hermes_mobile_delivery.inbox", level="WARNING"):
                self.assertTrue(deliver_pending(path, self.endpoint, "inbox-token", "work"))
            self.assertNotIn("session_id", self.requests[0][2])
            self.assertEqual(pull(path, "work"), [(targeted_id, "")])
            self.clock.return_value += 300
            self.responses = iter([204])
            self.assertTrue(deliver_pending(path, self.endpoint, "inbox-token", "work"))
            self.assertEqual(pull(path, "work"), [])
            for request in self.requests[1:]:
                self.assertEqual(request[2]["delivery_id"], targeted_id)
                self.assertEqual(request[2]["session_id"], "mobile_session-1")
                self.assertEqual(request[2], self.requests[1][2])
            with sqlite3.connect(path) as db:
                self.assertEqual(db.execute("SELECT COUNT(*) FROM delivery_sessions").fetchone()[0], 0)

    def test_upload_failure_or_invalid_receipt_never_posts_or_acknowledges_delivery(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "queue.sqlite3"
            source = Path(directory) / "movie.mp4"
            source.write_bytes(b"video")
            delivery_id = enqueue(path, "work", "视频", [(source, "预览.mp4")])
            for status, corrupt in ((401, False), (200, True)):
                self.clock.return_value += 300
                self.upload_status, self.corrupt_upload_receipt = status, corrupt
                with self.assertLogs("hermes_mobile_delivery.inbox", level="WARNING"):
                    self.assertFalse(deliver_pending(path, self.endpoint, "inbox-token", "work"))
                self.assertEqual(pull(path, "work"), [(delivery_id, "视频")])
                self.assertEqual(self.requests, [])

    def test_accepts_canonical_image_mime_and_keeps_upload_metadata_stable_across_retry(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "queue.sqlite3"
            for filename, declared in (("plot", "application/octet-stream"), ("plot.jpg", "image/jpeg")):
                with self.subTest(filename=filename):
                    self.uploads.clear()
                    source = Path(directory) / filename
                    source.write_bytes(bytes.fromhex("89504e470d0a1a0a"))
                    delivery_id = enqueue(path, "work", "", [(source, None)])
                    self.upload_mime = "image/png"
                    self.responses = iter([503, 503, 503])
                    with self.assertLogs("hermes_mobile_delivery.inbox", level="WARNING"):
                        self.assertFalse(deliver_pending(path, self.endpoint, "inbox-token", "work"))
                    self.assertTrue(self.requests, "normalized upload should reach inbox delivery")
                    self.assertEqual(len(self.requests[-1][2]["attachments"]), 1)
                    self.assertEqual(self.requests[-1][2]["attachments"][0]["mime"], "image/png")
                    self.clock.return_value += 300
                    self.responses = iter([204])
                    self.assertTrue(deliver_pending(path, self.endpoint, "inbox-token", "work"))
                    self.assertEqual(self.uploads[0], self.uploads[1])
                    self.assertEqual(self.uploads[0][2]["mime"], declared)
                    self.assertEqual(self.requests[-1][2]["delivery_id"], delivery_id)
                    self.assertEqual(pull(path, "work"), [])

    def test_rejects_unexpected_mime_changes_in_upload_receipt(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "queue.sqlite3"
            source = Path(directory) / "report.md"
            source.write_bytes(b"# Report")
            delivery_id = enqueue(path, "work", "", [(source, None)])
            for mime in ("text/html", "invalid/type\r\n", "image/svg+xml"):
                self.clock.return_value += 300
                self.upload_mime = mime
                with self.assertLogs("hermes_mobile_delivery.inbox", level="WARNING"):
                    self.assertFalse(deliver_pending(path, self.endpoint, "inbox-token", "work"))
                self.assertEqual(pull(path, "work"), [(delivery_id, "")])
            self.assertEqual(self.requests, [])

    def test_normalizes_display_name_before_upload_and_rejects_dot_names(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "queue.sqlite3"
            source = Path(directory) / "report.md"
            source.write_bytes(b"# Report")
            enqueue(path, "work", "", [(source, "  日报.md  ")])
            self.clock.return_value += 300
            self.responses = iter([204])
            self.assertTrue(deliver_pending(path, self.endpoint, "inbox-token", "work"))
            self.assertEqual(self.uploads[0][2]["name"], "日报.md")
            self.assertEqual(self.requests[-1][2]["attachments"][0]["name"], "日报.md")
            for name in (" . ", " .. "):
                with self.assertRaises(ValueError):
                    enqueue(path, "work", "", [(source, name)])
            self.assertEqual(pull(path, "work"), [])

    def test_original_text_queue_remains_readable_when_attachments_are_added(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "queue.sqlite3"
            with sqlite3.connect(path) as db:
                db.execute("CREATE TABLE deliveries (delivery_id TEXT PRIMARY KEY, profile_ref TEXT NOT NULL, text TEXT NOT NULL)")
                db.execute("INSERT INTO deliveries VALUES (?, ?, ?)", (self.delivery_id, "work", "旧消息"))
            path.chmod(0o600)
            source = Path(directory) / "plot.png"
            source.write_bytes(b"image")
            file_delivery = enqueue(path, "work", "图片", [(source, None)])
            self.responses = iter([204, 204])
            self.assertTrue(deliver_pending(path, self.endpoint, "inbox-token", "work"))
            self.assertEqual([request[2]["delivery_id"] for request in self.requests], [self.delivery_id, file_delivery])
            self.assertNotIn("attachments", self.requests[0][2])

    def test_rejects_unsafe_files_and_limits_without_leaving_partial_delivery(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "queue.sqlite3"
            source = Path(directory) / "file.txt"
            source.write_bytes(b"ok")
            link = Path(directory) / "link.txt"
            link.symlink_to(source)
            large = Path(directory) / "large.mp4"
            with large.open("wb") as file:
                file.truncate(50 * 1024 * 1024 + 1)
            fifo = Path(directory) / "pipe.txt"
            os.mkfifo(fifo)
            for files in ([(link, None)], [(large, None)], [(fifo, None)], [(source, "../file.txt")],
                          [(source, "bad\x00name")], [(source, None)] * 11,
                          [(source, None), (Path(directory) / "missing.txt", None)]):
                with self.subTest(files=files), self.assertRaises((OSError, ValueError)):
                    enqueue(path, "work", "文件", files)
                self.assertEqual(pull(path, "work"), [])
