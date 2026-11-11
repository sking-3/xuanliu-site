"""Report local monitor blockers without requests, tokens, or checkpoint mutation."""
import json
import os
from pathlib import Path
import source_holds

EVIDENCE = Path(__file__).with_name('source-evidence.json')
OPERATIONS = ('binancePublicCollector', 'binancePositions5075281354358777856', 'githubRunInventory')


def report():
    blockers = [{'operation': op, 'reason': reason} for op in OPERATIONS
                if (reason := source_holds.reason(op))]
    # A code review, rather than a runtime variable, controls this workflow gate.
    blockers.append({'operation': 'githubLiveJob', 'reason': 'disabled_in_workflow'})
    try:
        evidence = json.loads(EVIDENCE.read_text())
        if (not isinstance(evidence, dict) or evidence.get('schemaVersion') != 1 or evidence.get('portfolioId') != '5075281354358777856'
                or evidence.get('positionShow') is not False or evidence.get('requestsMade') != 1):
            raise ValueError('invalid evidence')
        visibility = {key: evidence[key] for key in ('requestStartedAt', 'httpStatus',
                      'businessSuccess', 'identityMatches', 'positionShow', 'responseSha256')}
    except (OSError, ValueError, TypeError, KeyError):
        visibility = None
        blockers.append({'operation': 'visibilityEvidence', 'reason': 'unverified'})
    return {'portfolioId': '5075281354358777856', 'status': 'blocked', 'reportScope': 'legacy_combined_position_monitor',
            'publicExecutionObserverConfigured': source_holds.reason('binanceOrders5075281354358777856') is None,
            'configuredIntervalSeconds': 5, 'sourceRequestsMade': 0,
            'backgroundMonitorRunning': False, 'blockers': blockers,
            'lastVisibilityVerification': visibility}


def summary(result):
    rows = ['## 旧仓位监控：未启用', '',
            '目标组合：`5075281354358777856`。本摘要仅针对旧仓位观察器。',
            '公开成交记录已改用独立的 Binance public execution watch 工作流；本步骤不查询其存活状态。',
            '本步骤只检查仓库文件，没有请求币安、受限运行队列或读取账户密钥。', '',
            '| 停止项 | 原因 |', '| --- | --- |']
    rows += [f"| `{r['operation']}` | `{r['reason']}` |" for r in result['blockers']]
    evidence = result['lastVisibilityVerification']
    if evidence:
        rows += ['', f"最近一次公开状态核验始于 `{evidence['requestStartedAt']}`；HTTP {evidence['httpStatus']}，`positionShow=false`。",
                 '该记录仅核验持仓可见性，不能用它否定独立公开的成交记录。隐藏仓位仍不请求。']
    return '\n'.join(rows) + '\n'


def main():
    result = report()
    print(json.dumps(result, ensure_ascii=False))
    if path := os.environ.get('GITHUB_STEP_SUMMARY'):
        with Path(path).open('a') as output:
            output.write(summary(result))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
