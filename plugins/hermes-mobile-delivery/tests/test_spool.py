import sqlite3
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from hermes_mobile_delivery import spool


class SpoolSchedulingTest(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "queue.sqlite3"
        self.clock = patch("hermes_mobile_delivery.spool.time.time", return_value=1000)

    def test_failed_head_keeps_snapshot_but_does_not_hide_later_deliveries(self):
        source = self.path.with_name("report.md")
        source.write_bytes(b"saved report")
        bad = spool.enqueue(self.path, "work", "bad", [(source, None)], session_id="missing_session")
        good = spool.enqueue(self.path, "work", "good")
        source.unlink()
        token = spool.begin_attempt(self.path, "work", bad)
        self.assertTrue(token)
        self.assertEqual(spool.finish_attempt(self.path, "work", bad, "failed", 404,
                                             "DELIVERY_TARGET_NOT_FOUND", attempt_token=token), "failed")
        self.assertEqual(spool.due(self.path, "work"), [(good, "good")])
        record = spool.inspect_queue(self.path, "work", bad)[0]
        self.assertEqual((record["state"], record["session_id"], record["attempts"], record["http_status"]),
                         ("failed", "missing_session", 1, 404))
        self.assertEqual(record["error_code"], "DELIVERY_TARGET_NOT_FOUND")
        self.assertEqual(next(spool.attachments(self.path, bad))[1], b"saved report")
        self.assertNotIn("content", record["attachments"][0])
        self.assertTrue(spool.retry(self.path, "work", bad))
        self.assertEqual(spool.delivery_session(self.path, bad), "missing_session")
        self.assertTrue(spool.cancel(self.path, "work", bad))
        self.assertEqual(spool.inspect_queue(self.path, "work", bad)[0]["state"], "cancelled")
        self.assertFalse(spool.retry(self.path, "work", bad))
        self.assertEqual(next(spool.attachments(self.path, bad))[1], b"saved report")

    def test_legacy_records_gain_state_without_changing_targets(self):
        with sqlite3.connect(self.path) as db:
            db.execute("CREATE TABLE deliveries (delivery_id TEXT PRIMARY KEY, profile_ref TEXT NOT NULL, text TEXT NOT NULL)")
            db.execute("INSERT INTO deliveries VALUES ('old', 'work', 'legacy')")
        self.path.chmod(0o600)
        self.assertEqual(spool.due(self.path, "work"), [("old", "legacy")])
        self.assertIsNone(spool.inspect_queue(self.path, "work", "old")[0]["session_id"])

    def test_claim_blocks_parallel_consumers_and_profile_mismatch(self):
        delivery = spool.enqueue(self.path, "work", "hello")
        self.assertFalse(spool.begin_attempt(self.path, "other", delivery))
        self.assertTrue(spool.begin_attempt(self.path, "work", delivery))
        self.assertFalse(spool.begin_attempt(self.path, "work", delivery))
        self.assertFalse(spool.retry(self.path, "work", delivery))
        self.assertFalse(spool.cancel(self.path, "work", delivery))
        self.assertEqual(spool.due(self.path, "work"), [])
        self.assertEqual(spool.inspect_queue(self.path, "other", delivery), [])

    def test_retry_backoff_is_persistent_and_eventually_quarantines(self):
        with self.clock as now:
            delivery = spool.enqueue(self.path, "work", "hello")
            for attempt in range(1, 11):
                token = spool.begin_attempt(self.path, "work", delivery)
                self.assertTrue(token)
                result = spool.finish_attempt(self.path, "work", delivery, "retryable", 503, "HTTP_ERROR", attempt_token=token)
                record = spool.inspect_queue(self.path, "work", delivery)[0]
                self.assertEqual(record["attempts"], attempt)
                self.assertEqual(spool.due(self.path, "work"), [])
                if attempt < 10:
                    self.assertEqual(result, "retryable")
                    self.assertGreater(record["next_attempt_at"], now.return_value)
                    self.assertLessEqual(record["next_attempt_at"] - now.return_value, 300)
                    now.return_value = record["next_attempt_at"]
                else:
                    self.assertEqual(result, "failed")
            self.assertTrue(spool.retry(self.path, "work", delivery))
            self.assertEqual(spool.due(self.path, "work"), [(delivery, "hello")])
            self.assertEqual(spool.inspect_queue(self.path, "work", delivery)[0]["attempts"], 0)

    def test_auth_pause_is_profile_wide_persistent_and_can_be_resumed(self):
        with self.clock as now:
            first = spool.enqueue(self.path, "work", "first")
            second = spool.enqueue(self.path, "work", "second")
            other = spool.enqueue(self.path, "other", "other")
            token = spool.begin_attempt(self.path, "work", first)
            self.assertTrue(token)
            self.assertEqual(spool.finish_attempt(self.path, "work", first, "auth_blocked", 401, "UNAUTHORIZED", attempt_token=token), "auth_blocked")
            self.assertEqual(spool.due(self.path, "work"), [])
            self.assertFalse(spool.begin_attempt(self.path, "work", second))
            self.assertEqual(spool.due(self.path, "other"), [(other, "other")])
            record = spool.inspect_queue(self.path, "work", first)[0]
            self.assertEqual(record["paused_until"], 1300)
            now.return_value = 1300
            self.assertEqual(set(spool.due(self.path, "work")), {(first, "first"), (second, "second")})
            token = spool.begin_attempt(self.path, "work", first)
            self.assertTrue(token)
            spool.finish_attempt(self.path, "work", first, "auth_blocked", 403, "FORBIDDEN", attempt_token=token)
            self.assertTrue(spool.retry(self.path, "work", first))
            self.assertEqual(len(spool.due(self.path, "work")), 2)

    def test_expired_worker_lease_can_be_reclaimed(self):
        with self.clock as now:
            delivery = spool.enqueue(self.path, "work", "hello")
            self.assertTrue(spool.begin_attempt(self.path, "work", delivery))
            now.return_value = 2199
            self.assertEqual(spool.due(self.path, "work"), [])
            now.return_value = 2200
            self.assertEqual(spool.due(self.path, "work"), [(delivery, "hello")])
            self.assertTrue(spool.begin_attempt(self.path, "work", delivery))
            self.assertEqual(spool.inspect_queue(self.path, "work", delivery)[0]["attempts"], 2)

    def test_new_deliveries_do_not_starve_an_older_due_retry(self):
        with self.clock as now:
            first = spool.enqueue(self.path, "work", "first")
            token = spool.begin_attempt(self.path, "work", first)
            self.assertTrue(token)
            spool.finish_attempt(self.path, "work", first, "retryable", 503, "HTTP_ERROR", attempt_token=token)
            now.return_value = 1006
            second = spool.enqueue(self.path, "work", "second")
            self.assertEqual(spool.due(self.path, "work"), [(first, "first"), (second, "second")])

    def test_twenty_failed_records_do_not_starve_twenty_first(self):
        bad = [spool.enqueue(self.path, "work", "bad") for _ in range(20)]
        good = spool.enqueue(self.path, "work", "good")
        self.assertEqual(len(spool.due(self.path, "work")), 20)
        for delivery in bad:
            token = spool.begin_attempt(self.path, "work", delivery)
            self.assertTrue(token)
            spool.finish_attempt(self.path, "work", delivery, "failed", 422, "VALIDATION_FAILED", attempt_token=token)
        self.assertEqual(spool.due(self.path, "work"), [(good, "good")])

    def test_ack_deletes_state_and_snapshot_only_after_confirmation(self):
        delivery = spool.enqueue(self.path, "work", "hello", session_id="target")
        token = spool.begin_attempt(self.path, "work", delivery)
        self.assertTrue(token)
        spool.ack(self.path, delivery, attempt_token=token)
        self.assertEqual(spool.inspect_queue(self.path, "work"), [])
        with sqlite3.connect(self.path) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM delivery_state").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM delivery_sessions").fetchone()[0], 0)

    def test_expired_worker_cannot_delete_cancelled_evidence(self):
        with self.clock as now:
            source = self.path.with_name("report.md")
            source.write_bytes(b"saved report")
            delivery = spool.enqueue(self.path, "work", "hello", [(source, None)], session_id="target")
            token = spool.begin_attempt(self.path, "work", delivery)
            now.return_value = 2200
            self.assertTrue(spool.cancel(self.path, "work", delivery))
            self.assertFalse(spool.ack(self.path, delivery, attempt_token=token))
            self.assertFalse(spool.renew_attempt(self.path, "work", delivery, token))
            self.assertEqual(len(spool.inspect_queue(self.path, "work", delivery)), 1)
            self.assertEqual(next(spool.attachments(self.path, delivery))[1], b"saved report")

    def test_expired_worker_cannot_overwrite_a_newer_claim(self):
        with self.clock as now:
            delivery = spool.enqueue(self.path, "work", "hello")
            old_token = spool.begin_attempt(self.path, "work", delivery)
            now.return_value = 2200
            new_token = spool.begin_attempt(self.path, "work", delivery)
            self.assertNotEqual(old_token, new_token)
            self.assertEqual(spool.finish_attempt(self.path, "work", delivery, "auth_blocked", 401,
                                                   "UNAUTHORIZED", attempt_token=old_token), "delivering")
            record = spool.inspect_queue(self.path, "work", delivery)[0]
            self.assertEqual(record["state"], "delivering")
            self.assertIsNone(record["paused_until"])

    def test_only_current_claim_can_renew_and_acknowledge(self):
        with self.clock as now:
            delivery = spool.enqueue(self.path, "work", "hello")
            old_token = spool.begin_attempt(self.path, "work", delivery)
            now.return_value = 2200
            new_token = spool.begin_attempt(self.path, "work", delivery)
            self.assertNotEqual(old_token, new_token)
            self.assertFalse(spool.renew_attempt(self.path, "work", delivery, old_token))
            self.assertFalse(spool.renew_attempt(self.path, "other", delivery, new_token))
            self.assertFalse(spool.ack(self.path, delivery, attempt_token=old_token))
            now.return_value = 2300
            self.assertTrue(spool.renew_attempt(self.path, "work", delivery, new_token))
            now.return_value = 3400
            self.assertEqual(spool.due(self.path, "work"), [])
            self.assertTrue(spool.ack(self.path, delivery, attempt_token=new_token))
            self.assertEqual(spool.inspect_queue(self.path, "work"), [])
            self.assertEqual(spool.finish_attempt(self.path, "work", delivery, "retryable", 503,
                                                  "HTTP_ERROR", attempt_token=old_token), "delivered")
