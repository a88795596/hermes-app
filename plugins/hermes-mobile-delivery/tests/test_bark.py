from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from threading import Thread
import unittest

from hermes_mobile_delivery.bark import post_bark
from hermes_mobile_delivery.inbox import inbox_endpoint


class BarkDeliveryTest(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.status, self.response = 200, {"code": 200, "message": "success", "timestamp": 0}
        test = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                test.requests.append((self.path, self.headers.get_content_type(), json.loads(body)))
                self.send_response(test.status)
                self.send_header("Content-Type", "application/json")
                if test.status == 307:
                    self.send_header("Location", "/other")
                self.end_headers()
                self.wfile.write(json.dumps(test.response).encode())

            def log_message(self, *_):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.endpoint = inbox_endpoint(f"http://127.0.0.1:{server.server_port}/bark/")

    def test_sends_plain_text_with_the_configured_device_key(self):
        self.assertEqual(post_bark(self.endpoint, ["test-key"], "早报完成\n详见附件"), {"success": True})
        self.assertEqual(self.requests, [("/bark/push", "application/json", {
            "device_key": "test-key", "body": "早报完成\n详见附件",
        })])

    def test_passes_bark_fields_with_their_original_types(self):
        options = {
            "title": "发布完成", "subtitle": "生产环境", "body": "文字", "markdown": "**发布完成**",
            "group": "部署", "icon": "https://example.com/icon.png", "image": "https://example.com/image.png",
            "badge": 0, "level": "critical", "volume": "0", "call": "1", "sound": "minuet",
            "soundUrl": "https://example.com/sound.caf", "copy": "1+2=3", "autoCopy": "1",
            "url": "example://reports/latest?lang=zh&tab=all", "action": "alert", "isArchive": "0", "ttl": 120,
            "id": "deploy", "delete": "1", "ciphertext": "YQ==", "iv": "0123456789012345",
        }
        self.assertEqual(post_bark(self.endpoint, ["test-key"], json.dumps(options)), {"success": True})
        self.assertEqual(self.requests[0][2], {**options, "device_key": "test-key"})

    def test_uses_device_keys_and_reports_partial_rejection_without_echoing_keys(self):
        self.response["data"] = [{"code": 200, "device_key": "test-key-1"}, {"code": 200, "device_key": "test-key-2"}]
        keys = ["test-key-1", "test-key-2"]
        message = '{"id":"deploy","delete":"1"}'
        self.assertEqual(post_bark(self.endpoint, keys, message), {"success": True})
        self.response["data"][1].update(code=400, message="rejected test-key-2")
        result = post_bark(self.endpoint, keys, message)
        self.assertIn("1/2", result["error"])
        self.assertNotIn("test-key", result["error"])
        self.assertEqual(self.requests, [("/bark/push", "application/json", {
            "device_keys": keys, "id": "deploy", "delete": "1",
        })] * 2)

    def test_rejects_invalid_json_and_device_keys_from_the_message(self):
        for message in ('{"body":', '{"badge": NaN}', '{"body":"测试","DEVICE_KEY":"override"}',
                        '{"device_keys":["override"],"body":"测试"}'):
            with self.subTest(message=message):
                self.assertIn("error", post_bark(self.endpoint, ["test-key"], message))
        self.assertEqual(self.requests, [])

    def test_requires_a_success_receipt_and_does_not_follow_redirects(self):
        for status, response in ((200, {"code": 400, "message": "rejected test-key"}),
                                 (200, "invalid receipt"), (307, {})):
            with self.subTest(status=status, response=response):
                self.status, self.response = status, response
                result = post_bark(self.endpoint, ["test-key"], "早报完成")
                self.assertIn("error", result)
                self.assertNotIn("test-key", result["error"])
        self.assertEqual([request[0] for request in self.requests], ["/bark/push"] * 3)
