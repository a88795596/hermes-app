from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import unittest
from uuid import uuid4

from hermes_mobile_delivery.inbox import deliver_pending, inbox_endpoint, post_delivery
from hermes_mobile_delivery.spool import enqueue, pull


class InboxDeliveryTest(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.responses = iter(())
        test = self

        class Handler(BaseHTTPRequestHandler):
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
        return post_delivery(self.endpoint, "inbox-token", self.delivery_id, "work", "早报完成")

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

            self.responses = iter([204])
            self.assertTrue(deliver_pending(path, self.endpoint, "inbox-token", "work"))
            self.assertEqual([request[2]["delivery_id"] for request in self.requests], [delivery_id] * 4)
            self.assertEqual(pull(path, "work"), [])
            self.assertEqual(pull(path, "other"), [(another_id, "其他配置档案")])
