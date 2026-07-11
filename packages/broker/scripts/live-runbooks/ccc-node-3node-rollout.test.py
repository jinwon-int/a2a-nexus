import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

MODULE_PATH = Path(__file__).with_name("ccc-node-3node-rollout.py")
SPEC = importlib.util.spec_from_file_location("ccc_node_rollout", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
rollout = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rollout)


class RolloutTests(unittest.TestCase):
    def args(self, phase="preflight", action="promote_to_live_apply", sha="d" * 40):
        return rollout.parse_args([
            "--phase", phase,
            "--task-id", "task-live-343-1",
            "--run-id", "run-live-343-1",
            "--action", action,
            "--runbook-id", rollout.RUNBOOK_ID,
            "--target", f"ccc-node:fleet:{sha}",
            "--target-sha", sha,
            "--worker-id", "nosuk",
            "--receipt-mac", "a" * 64,
        ])

    def test_target_binds_full_sha_and_prompt_command_is_not_accepted(self):
        self.args()
        with self.assertRaises(SystemExit):
            rollout.parse_args([
                "--phase", "apply", "--task-id", "task", "--run-id", "run",
                "--action", "promote_to_live_apply", "--runbook-id", rollout.RUNBOOK_ID,
                "--target", f"ccc-node:fleet:{'a' * 40}", "--target-sha", "b" * 40,
                "--worker-id", "nosuk", "--receipt-mac", "c" * 64,
                "--command", "sh -c pwned",
            ])

    def test_apply_approval_cannot_invoke_rollback(self):
        with self.assertRaises(SystemExit):
            self.args(phase="rollback", action="promote_to_live_apply")

    def test_fixed_scripts_use_only_allowlisted_repo_service_and_target_sha(self):
        sha = "e" * 40
        script = rollout.remote_script("apply", sha, "promote_to_live_apply")
        self.assertIn("cd /opt/ccc-node", script)
        self.assertIn("ccc-telegram-bridge.service", script)
        self.assertIn(f"git merge --ff-only {sha}", script)
        self.assertIn("export HOME=/root", script)
        self.assertIn("export LANG=C.UTF-8", script)
        self.assertIn("export PYTHONPATH=/opt/ccc-node/.github/pythonpath", script)
        self.assertIn("export TELEGRAM_BOT_TOKEN=a2a-runbook-test-placeholder", script)
        self.assertIn("bridge.tests.test_bash_policy", script)
        self.assertIn("bridge.tests.test_revert", script)
        self.assertIn("bridge.tests.test_watchdog", script)
        self.assertNotIn("test_project_chat_retry", script)
        self.assertNotIn("command -v shellcheck", script)
        self.assertNotIn("eval", script)

    def test_mutating_phase_is_idempotent_by_task_run_and_phase(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence = {"old": "c" * 40, "head": "d" * 40, "origin": "d" * 40,
                        "service": "active", "pid": "123", "restarts": "0"}
            calls = []

            def fake_run(node, script):
                calls.append((node, script))
                return {"node": node, **evidence}

            with patch.object(rollout, "STATE_ROOT", Path(directory)), patch.object(rollout, "run_node", fake_run):
                args = self.args(phase="apply")
                first = rollout.execute(args)
                second = rollout.execute(args)
            self.assertTrue(first["ok"])
            self.assertEqual(first, second)
            self.assertEqual([node for node, _ in calls], list(rollout.NODES))

    def test_verify_requires_all_nodes_exact_sha_active_and_zero_restarts(self):
        with tempfile.TemporaryDirectory() as directory:
            sha = "d" * 40

            def fake_run(node, script):
                return {"node": node, "old": sha, "head": sha, "origin": sha,
                        "service": "active", "pid": "123", "restarts": "0"}

            with patch.object(rollout, "STATE_ROOT", Path(directory)), patch.object(rollout, "run_node", fake_run):
                result = rollout.execute(self.args(phase="verify", sha=sha))
            self.assertTrue(result["verification"]["done"])
            self.assertEqual(result["verification"]["targetSha"], sha)
            self.assertEqual(len(result["verification"]["nodes"]), 3)


if __name__ == "__main__":
    unittest.main()
