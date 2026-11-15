import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from hermes_mobile_delivery.inbox import deliver_pending, inbox_endpoint
from hermes_mobile_delivery.spool import enqueue, pull


class DeliveryRecoveryTest(unittest.TestCase):
    def setUp(self):
        timer = patch("hermes_mobile_delivery.spool.time.time", return_value=1000)
        timer.start()
        self.addCleanup(timer.stop)

    def test_bad_session_does_not_block_later_inbox_session_or_attachment(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'queue.sqlite3'
            source = Path(directory) / 'report.md'
            source.write_bytes(b'# Report')
            bad = enqueue(path, 'default', 'bad', session_id='mobile_missing')
            good = [enqueue(path, 'default', 'inbox'),
                    enqueue(path, 'default', 'session', session_id='mobile_ready'),
                    enqueue(path, 'default', '', [(source, None)], session_id='mobile_ready')]
            received = []

            def request(endpoint, token, method, url, payload):
                if method == 'PUT':
                    return 200, json.dumps({'data': {
                        'attachment_id': url.rsplit('/', 1)[1],
                        **{key: payload[key] for key in ('name', 'mime', 'size')},
                    }}).encode()
                if payload.get('session_id') == 'mobile_missing':
                    return 404, b'{"error":{"code":"DELIVERY_TARGET_NOT_FOUND"}}'
                received.append(payload)
                return 204, b''

            endpoint = inbox_endpoint('http://localhost/internal/inbox/v1/deliveries')
            with patch('hermes_mobile_delivery.inbox._request', side_effect=request):
                deliver_pending(path, endpoint, 'test-token', 'default')
                deliver_pending(path, endpoint, 'test-token', 'default')
            self.assertEqual([row['delivery_id'] for row in received], good,
                             'A rejected session must not block subsequent valid deliveries')
            self.assertEqual(pull(path, 'default'), [(bad, 'bad')])
            self.assertNotIn('session_id', received[0])
            self.assertEqual(received[1]['session_id'], 'mobile_ready')
            self.assertEqual(received[2]['session_id'], 'mobile_ready')
            self.assertEqual(len(received[2]['attachments']), 1)

    def test_more_than_a_batch_of_bad_targets_cannot_starve_a_good_delivery(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "queue.sqlite3"
            bad = [enqueue(path, "default", "bad", session_id="missing") for _ in range(20)]
            good = enqueue(path, "default", "good")
            seen = []

            def request(endpoint, token, method, url, payload):
                seen.append(payload["delivery_id"])
                return ((404, b'{"error":{"code":"DELIVERY_TARGET_NOT_FOUND"}}')
                        if "session_id" in payload else (204, b""))

            endpoint = inbox_endpoint("http://localhost/")
            with patch("hermes_mobile_delivery.inbox._request", side_effect=request):
                self.assertFalse(deliver_pending(path, endpoint, "token", "default"))
                self.assertTrue(deliver_pending(path, endpoint, "token", "default"))
                self.assertFalse(deliver_pending(path, endpoint, "token", "default"))
            self.assertEqual(seen, bad + [good])

    def test_classification_is_persisted_and_ineligible_records_are_not_polled(self):
        from hermes_mobile_delivery.spool import inspect_queue
        cases = [
            (404, "DELIVERY_TARGET_NOT_FOUND", "failed"),
            (409, "DELIVERY_TARGET_NOT_READY", "retryable"),
            (404, "NOT_FOUND", "retryable"),
            (409, "IDEMPOTENCY_CONFLICT", "failed"),
            (422, "VALIDATION_FAILED", "failed"),
            (401, "UNAUTHORIZED", "auth_blocked"),
            (403, "FORBIDDEN", "auth_blocked"),
            (408, "TIMEOUT", "retryable"),
            (429, "RATE_LIMITED", "retryable"),
            (503, "INTERNAL_ERROR", "retryable"),
            (None, None, "retryable"),
        ]
        for status, code, state in cases:
            with self.subTest(status=status, code=code), TemporaryDirectory() as directory:
                path = Path(directory) / "queue.sqlite3"
                delivery_id = enqueue(path, "default", "original", session_id="mobile_target")
                endpoint = inbox_endpoint("http://localhost/")
                body = json.dumps({"error": {"code": code}}).encode()
                with patch("hermes_mobile_delivery.spool.time.time", return_value=1000), \
                        patch("hermes_mobile_delivery.inbox._request", return_value=(status, body)) as request:
                    self.assertFalse(deliver_pending(path, endpoint, "token", "default"))
                    self.assertFalse(deliver_pending(path, endpoint, "token", "default"))
                    self.assertEqual(request.call_count, 1)
                item = inspect_queue(path, "default", delivery_id)[0]
                self.assertEqual(item["state"], state)
                self.assertEqual(item["http_status"], status)
                self.assertEqual(item["error_code"], code or "NETWORK_ERROR")
                self.assertEqual(item["session_id"], "mobile_target")
                self.assertEqual(item["text"], "original")
                self.assertEqual(item["attempts"], 1)

    def test_not_ready_recovers_with_original_attachment_and_delivery_identity(self):
        from hermes_mobile_delivery.spool import inspect_queue
        with TemporaryDirectory() as directory:
            path = Path(directory) / "queue.sqlite3"
            source = Path(directory) / "report.md"
            source.write_bytes(b"snapshot")
            delivery_id = enqueue(path, "default", "", [(source, None)], session_id="mobile_creating")
            source.unlink()
            uploads, posts = [], []

            def request(endpoint, token, method, url, payload):
                if method == "PUT":
                    uploads.append((url, payload))
                    return 200, json.dumps({"data": {"attachment_id": url.rsplit("/", 1)[1],
                        **{key: payload[key] for key in ("name", "mime", "size")}}}).encode()
                posts.append(payload)
                return ((409, b'{"error":{"code":"DELIVERY_TARGET_NOT_READY"}}')
                        if len(posts) == 1 else (204, b""))

            endpoint = inbox_endpoint("http://localhost/")
            with patch("hermes_mobile_delivery.spool.time.time", return_value=1000), \
                    patch("hermes_mobile_delivery.inbox._request", side_effect=request):
                deliver_pending(path, endpoint, "token", "default")
            item = inspect_queue(path, "default", delivery_id)[0]
            self.assertEqual(item["state"], "retryable")
            with patch("hermes_mobile_delivery.spool.time.time", return_value=item["next_attempt_at"]), \
                    patch("hermes_mobile_delivery.inbox._request", side_effect=request):
                self.assertTrue(deliver_pending(path, endpoint, "token", "default"))
            self.assertEqual(posts[0], posts[1])
            self.assertEqual(uploads[0], uploads[1])
            self.assertEqual(posts[1]["delivery_id"], delivery_id)
            self.assertEqual(posts[1]["session_id"], "mobile_creating")
            self.assertEqual(pull(path, "default"), [])

    def test_auth_pause_applies_to_later_messages_and_survives_new_connections(self):
        from hermes_mobile_delivery.inbox import deliver_one
        from hermes_mobile_delivery.spool import inspect_queue, retry
        with TemporaryDirectory() as directory:
            path = Path(directory) / "queue.sqlite3"
            bad = enqueue(path, "default", "first")
            good = enqueue(path, "default", "second")
            endpoint = inbox_endpoint("http://localhost/")
            with patch("hermes_mobile_delivery.spool.time.time", return_value=1000), \
                    patch("hermes_mobile_delivery.inbox._request", return_value=(403, b"")) as request:
                deliver_pending(path, endpoint, "token", "default")
                deliver_pending(path, endpoint, "token", "default")
                deliver_one(path, endpoint, "token", "default", good, "second")
                self.assertEqual(request.call_count, 1)
            self.assertEqual(inspect_queue(path, "default", bad)[0]["state"], "auth_blocked")
            self.assertTrue(retry(path, "default", bad))
            with patch("hermes_mobile_delivery.inbox._request", return_value=(204, b"")):
                self.assertTrue(deliver_pending(path, endpoint, "fixed-token", "default"))
            self.assertEqual(pull(path, "default"), [])

    def test_cancelled_expired_upload_cannot_continue_to_message_submission(self):
        from hermes_mobile_delivery.spool import cancel, inspect_queue
        with TemporaryDirectory() as directory:
            path = Path(directory) / "queue.sqlite3"
            source = Path(directory) / "report.md"
            source.write_bytes(b"snapshot")
            delivery_id = enqueue(path, "default", "", [(source, None)], session_id="mobile_target")
            requests = []

            def request(endpoint, token, method, url, payload):
                requests.append(method)
                with patch("hermes_mobile_delivery.spool.time.time", return_value=3000):
                    self.assertTrue(cancel(path, "default", delivery_id))
                return 200, json.dumps({"data": {"attachment_id": url.rsplit("/", 1)[1],
                    **{key: payload[key] for key in ("name", "mime", "size")}}}).encode()

            endpoint = inbox_endpoint("http://localhost/")
            with patch("hermes_mobile_delivery.inbox._request", side_effect=request):
                self.assertFalse(deliver_pending(path, endpoint, "token", "default"))
            self.assertEqual(requests, ["PUT"])
            item = inspect_queue(path, "default", delivery_id)[0]
            self.assertEqual(item["state"], "cancelled")
            self.assertEqual(item["session_id"], "mobile_target")
            self.assertEqual(len(item["attachments"]), 1)


if __name__ == '__main__':
    unittest.main()
