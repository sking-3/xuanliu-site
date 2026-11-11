"""Report local monitor blockers without requests, tokens, or checkpoint mutation."""
import json
import os
from pathlib import Path
import source_holds

EVIDENCE = Path(__file__).with_name('source-evidence.json')
OPERATIONS = ('binancePublicCollector', 'binanceOrders5075281354358777856', 'githubRunInventory')


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
    return {'portfolioId': '5075281354358777856', 'status': 'blocked',
            'configuredIntervalSeconds': 5, 'sourceRequestsMade': 0,
            'backgroundMonitorRunning': False, 'blockers': blockers,
            'lastVisibilityVerification': visibility}


def summary(result):
    rows = ['## 币安五秒监控：未启用', '',
            '目标组合：`5075281354358777856`；程序目标节拍为 5 秒。',
            '本步骤只检查仓库文件，没有请求币安、受限运行队列或读取账户密钥。', '',
            '| 停止项 | 原因 |', '| --- | --- |']
    rows += [f"| `{r['operation']}` | `{r['reason']}` |" for r in result['blockers']]
    evidence = result['lastVisibilityVerification']
    if evidence:
        rows += ['', f"最近一次公开状态核验始于 `{evidence['requestStartedAt']}`；HTTP {evidence['httpStatus']}，`positionShow=false`。",
                 '该记录是历史核验结果，不代表本次任务重新请求过来源。没有持仓、订单或新开仓监控结果。']
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
