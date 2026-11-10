"""Read existing Books research snapshots offline. All output is dated historical research."""
import argparse
import json
import math
import re
from datetime import date
from pathlib import Path

A_RULES = {'M1', 'M2', 'M3', 'M4', 'M5'}
US_KEYS = ('close','turnover','gap','rvol','dayret','ma20','ma50','high20','excess')
PARAMS = ('min_price','min_turnover','event_gap','event_volume','break_volume','max_extension','near_high')


def day(value):
    return date.fromisoformat(value).isoformat()


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def us_rows(snapshot):
    asof = day(snapshot['asof'])
    p = snapshot['params']
    if any(not finite(p.get(k)) or p[k] < 0 for k in PARAMS) or p['near_high'] >= 1:
        raise ValueError('无有效的工作簿参数')
    result = []
    for item in snapshot['stocks']:
        code = item['ticker']
        m = item.get('m') or {}
        row = dict(symbol=code, name=item['name'], hits=[], status='待核', note='', close=None)
        result.append(row)
        if (m.get('asof') != asof or not all(finite(m.get(k)) for k in US_KEYS)
                or min(m['close'], m['ma20'], m['ma50'], m['high20']) <= 0
                or min(m['turnover'], m['rvol']) < 0 or type(m.get('ma50_up')) is not bool):
            row['note'] = '同日复权日线或基准指标不完整'
            continue
        row['close'] = m['close']
        if m['close'] < p['min_price'] or m['turnover'] < p['min_turnover']:
            row.update(status='排除',note='价格或20日均成交额低于工作簿门槛')
            continue
        hits = row['hits']
        if m['gap'] >= p['event_gap'] and m['rvol'] >= p['event_volume'] and m['dayret'] > 0:
            hits.append('U1')
        trend = m['close'] > m['ma20'] > m['ma50'] and m['ma50_up'] and m['excess'] > 0
        extension = m['close']/m['ma20'] - 1
        if trend and extension <= p['max_extension']:
            if m['close'] > m['high20'] and m['rvol'] >= p['break_volume']:
                hits.append('U2')
            if 1-p['near_high'] <= m['close']/m['high20'] <= 1:
                hits.append('U3')
        row.update(status='历史观察' if hits else '未命中',
                   note=f"跳空 {m['gap']:.1%} · 量比 {m['rvol']:.2f} · 相对SPY 20日超额 {m['excess']:.1%}")
    return {'asof':asof, 'source':'美股复盘工作簿 · Yahoo Finance 复权日线及 SPY 同日基准',
            'parameters':{k:p[k] for k in PARAMS},'rows':result}


def a_rows(snapshot):
    if snapshot.get('schema_version') != 'books.screening.view.v1':
        raise ValueError('无法识别 A 股研究归档')
    asof = day(snapshot['as_of_date'])
    result = []
    for item in snapshot['rows']:
        code = item['symbol']
        name = item['name']
        g = item.get('geometric_result') or {}
        same_date = item.get('as_of_date') == asof
        hits = []
        if same_date and g.get('status_code') == 'IN_ZONE_RECLAIM' and g.get('geometric_observation_only') is True:
            hits.append('F1')
        for entry in item.get('research_branch_results', []):
            rule = entry.get('research_proxy_id')
            if same_date and entry.get('as_of_date') == asof and rule in ('P1','P2') and entry.get('state') == 'MATCH':
                hits.append(rule)
        # This archive explicitly lacks the dated exchange eligibility and adjustment proofs.
        # Never promote its matches to qualified candidates. Reject obvious scope exclusions first.
        excluded = not re.fullmatch(r'(?:60[0135]|00[0123])\d{3}',code) or bool(re.search(r'^(?:S?\*?ST|退市)|退$',name.strip(),re.I))
        note = '代码范围或证券简称显示不符合主板普通股口径' if excluded else str(item.get('qualification_evidence') or '交易所资格待核')
        unresolved = [r['mode_id'] for r in item.get('mode_results',[]) if r.get('mode_id') in A_RULES and r.get('state')=='UNDETERMINED']
        result.append(dict(symbol=code,name=name,hits=list(dict.fromkeys(hits)),status='排除' if excluded else '待核',
                           pending=list(dict.fromkeys(unresolved)),close=None,note=note+' · '+str(g.get('status') or '行情待核')))
    return {'asof':asof, 'source':'Books 历史研究归档 · '+snapshot['source']['filename'], 'rows':result}


def build(a, us):
    output = {'schema':'books.research.review.v1','a':a_rows(a),'us':us_rows(us)}
    for market in ('a','us'):
        rows = output[market]['rows']
        if len(rows) != len({r['symbol'] for r in rows}):
            raise ValueError('输入中证券重复，需核对来源版本')
    return output


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for key in ('a','us','output'):
        parser.add_argument('--'+key,type=Path,required=True)
    args=parser.parse_args()
    output=build(json.loads(args.a.read_text()),json.loads(args.us.read_text()))
    args.output.write_text(json.dumps(output,ensure_ascii=False,separators=(',',':'))+'\n')
