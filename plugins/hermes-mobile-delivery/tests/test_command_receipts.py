from concurrent.futures import ThreadPoolExecutor
import importlib
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Barrier
import unittest

from hermes_mobile_delivery import spool


class CommandReceiptsTest(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "queue.sqlite3"
        self.args = (self.path, "work", "request-1", "mobile_session", "/restart")

    def test_unconfirmed_command_is_not_reexecuted_after_reload(self):
        self.assertEqual(spool.start_command(*self.args), (True, None))
        importlib.reload(spool)
        claimed, result = spool.start_command(*self.args)
        self.assertFalse(claimed)
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "unknown")
        self.assertIn("无法确认", result["error"])
        self.assertIn("请勿重复执行", result["error"])

    def test_same_request_rejects_other_profile_session_or_command(self):
        spool.start_command(*self.args)
        for index, value in ((1, "outside"), (3, "mobile_other"), (4, "/version")):
            args = list(self.args)
            args[index] = value
            with self.subTest(index=index), self.assertRaises(ValueError):
                spool.start_command(*args)
        self.assertFalse(spool.start_command(*self.args)[0])

    def test_finished_result_is_durable_and_only_the_matching_profile_can_finish(self):
        spool.start_command(*self.args)
        result = {"ok": True, "output": "正在等待当前任务结束后重启。"}
        for profile, request in (("outside", "request-1"), ("work", "missing")):
            with self.subTest(profile=profile, request=request), self.assertRaises(ValueError):
                spool.finish_command(self.path, profile, request, result)
        spool.finish_command(self.path, "work", "request-1", result)
        importlib.reload(spool)
        self.assertEqual(spool.start_command(*self.args), (False, result))

    def test_concurrent_requests_claim_execution_once(self):
        barrier = Barrier(8)

        def claim(_):
            barrier.wait()
            return spool.start_command(*self.args)

        with ThreadPoolExecutor(max_workers=8) as executor:
            results = list(executor.map(claim, range(8)))
        self.assertEqual(sum(claimed for claimed, _ in results), 1)
        self.assertTrue(all(result and result["ok"] is False for claimed, result in results if not claimed))

    def test_read_only_receipt_lookup_never_claims_and_checks_session_and_profile(self):
        self.assertIsNone(spool.read_command(self.path, "work", "request-1", "mobile_session"))
        self.assertEqual(spool.start_command(*self.args), (True, None))
        self.assertEqual(spool.read_command(self.path, "work", "request-1", "mobile_session")["status"], "unknown")
        for profile, session in (("other", "mobile_session"), ("work", "mobile_other")):
            with self.assertRaises(ValueError):
                spool.read_command(self.path, profile, "request-1", session)
        result = {"ok": True, "output": "原生撤回", "native_result": {"rewound_turns": 1}}
        spool.finish_command(self.path, "work", "request-1", result)
        self.assertEqual(spool.read_command(self.path, "work", "request-1", "mobile_session"), result)


if __name__ == "__main__":
    unittest.main()
