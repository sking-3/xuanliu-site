import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import readiness
import monitor


class ReadinessTests(unittest.TestCase):
    def test_reports_all_source_stops_without_network_or_state(self):
        with patch.object(monitor, 'Transport', side_effect=AssertionError('network')), patch.object(monitor, 'Store', side_effect=AssertionError('database')):
            result = readiness.report()
        self.assertEqual(result['sourceRequestsMade'], 0)
        self.assertFalse(result['backgroundMonitorRunning'])
        self.assertEqual(result['configuredIntervalSeconds'], 5)
        self.assertEqual({r['operation'] for r in result['blockers']}, set(readiness.OPERATIONS) | {'githubLiveJob'})
        self.assertFalse(result['lastVisibilityVerification']['positionShow'])

    def test_invalid_or_missing_evidence_remains_blocked(self):
        for content in ('bad json', '[]', '{"schemaVersion":1}'):
            with self.subTest(content=content), tempfile.TemporaryDirectory() as temp:
                path = Path(temp) / 'evidence.json';path.write_text(content)
                with patch.object(readiness, 'EVIDENCE', path):
                    result = readiness.report()
                self.assertEqual(result['status'], 'blocked')
                self.assertIsNone(result['lastVisibilityVerification'])
        with patch.object(readiness, 'EVIDENCE', Path('/nonexistent-evidence')):
            self.assertIsNone(readiness.report()['lastVisibilityVerification'])

    def test_cli_summary_distinguishes_historical_verification_and_this_run(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {'GITHUB_STEP_SUMMARY': str(Path(temp) / 'summary.md')}):
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(readiness.main(), 0)
            result=json.loads(output.getvalue());self.assertEqual(result['status'], 'blocked')
            summary=Path(temp, 'summary.md').read_text()
            self.assertIn('未启用', summary)
            self.assertIn('历史核验结果', summary)
            self.assertIn('positionShow=false', summary)

    def test_workflow_and_monitor_retained_the_pre_request_stop_gate(self):
        root=Path(__file__).resolve().parents[2]
        workflow=(root/'.github/workflows/binance-python-watch.yml').read_text()
        self.assertIn('if: ${{ false &&', workflow)
        self.assertIn('python tools/binance_watch/readiness.py', workflow)
        self.assertNotIn('\n  schedule:', workflow)
        self.assertEqual(readiness.source_holds.reason('binanceOrders5075281354358777856'), 'positions_not_public')
        with patch.object(monitor, 'Transport', side_effect=AssertionError('network')), patch.object(monitor, 'Store', side_effect=AssertionError('database')), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(monitor.main(['--once']), 2)


if __name__ == '__main__':
    unittest.main()
