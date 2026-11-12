"""Normalize vendor response exports. Credentials and network requests are out of scope."""
from datetime import datetime
from zoneinfo import ZoneInfo


def tushare_table(raw):
    if raw.get('code') in [2002, -2002]:
        raise ValueError('permission_denied_stop')
    if raw.get('code') != 0:
        raise ValueError('provider_error_stop')
    data = raw.get('data') or {}
    fields, rows = data.get('fields'), data.get('items')
    if not isinstance(fields, list) or not isinstance(rows, list) or len(set(fields)) != len(fields):
        raise ValueError('table_schema')
    if any(not isinstance(r,list) or len(r) != len(fields) for r in rows):
        raise ValueError('table_schema')
    return [dict(zip(fields, row)) for row in rows]


def a_daily(raw, factors):
    factors = {(r['ts_code'], r['trade_date']):float(r['adj_factor']) for r in tushare_table(factors)}
    rows = tushare_table(raw)
    latest = {}
    for r in rows:
        latest[r['ts_code']] = max(latest.get(r['ts_code'], ''), r['trade_date'])
    result = {}
    seen = set()
    for r in rows:
        key = (r['ts_code'], r['trade_date'])
        if key in seen:
            raise ValueError('duplicate_bar')
        seen.add(key)
        factor = factors.get((r['ts_code'],r['trade_date']))
        anchor = factors.get((r['ts_code'],latest[r['ts_code']]))
        if not factor or factor <= 0 or not anchor or anchor <= 0:
            raise ValueError('adjustment_factor_missing')
        symbol = r['ts_code']
        result.setdefault(symbol, []).append(dict(date=datetime.strptime(r['trade_date'],'%Y%m%d').date().isoformat(),
                **{k:float(r[k])*factor/anchor for k in ['open','high','low','close']},
                volume=float(r['vol'])*100, turnover=float(r['amount'])*1000))
    return {k:sorted(v,key=lambda b:b['date']) for k,v in result.items()}


def us_daily(pages):
    result, seen_tokens, stamps = {}, set(), set()
    if not pages:
        raise ValueError('empty_pages')
    for i, page in enumerate(pages):
        if not isinstance(page.get('bars'),dict):
            raise ValueError('bars_schema')
        token = page.get('next_page_token')
        if i < len(pages)-1 and not token or i == len(pages)-1 and token:
            raise ValueError('pagination_incomplete')
        if token in seen_tokens and token is not None:
            raise ValueError('pagination_not_advancing')
        seen_tokens.add(token)
        for symbol, bars in page['bars'].items():
            for r in bars:
                key = (symbol,r['t'])
                if key in stamps:
                    raise ValueError('duplicate_bar')
                stamps.add(key)
                day = datetime.fromisoformat(r['t'].replace('Z','+00:00')).astimezone(ZoneInfo('America/New_York')).date().isoformat()
                if r.get('vw') is None:
                    raise ValueError('turnover_basis_missing')
                result.setdefault(symbol, []).append(dict(date=day, open=float(r['o']), high=float(r['h']),
                    low=float(r['l']), close=float(r['c']), volume=float(r['v']),
                    turnover=float(r['vw'])*float(r['v'])))
    return {k:sorted(v,key=lambda b:b['date']) for k,v in result.items()}
