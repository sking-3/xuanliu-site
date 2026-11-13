"""One-shot, network-free research publication from an authorized source batch."""
import argparse
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
try:
    from .engine import screen, anomalies
except ImportError:
    from engine import screen, anomalies

SCHEMA = 'books.stock.workspace.v1'
SOURCE_KEYS = ['id', 'name', 'receivedAt', 'dataAsOf', 'coverage', 'expectedCount',
               'paginationComplete', 'permissionsVerified', 'redistributionAllowed', 'feed', 'errorCode']


def public_source(source):
    return (source.get('permissionsVerified') is True
            and source.get('redistributionAllowed') is True
            and source.get('accessScope') in [None, 'public'])


def public_audience(snapshot):
    return snapshot.get('audience') in [None, 'public']


def empty():
    return dict(schema=SCHEMA, publishedAt=datetime.now(timezone.utc).isoformat(),
                markets={k:dict(status='not_configured', asOf=None, source=None, parameters=None,
                               rows=[], completeUniverse=False) for k in ['a', 'us']},
                observations=[], alerts=[], execution=dict(backgroundEnabled=False, realOrdersSent=0))


def build(raw, previous=None, now=None):
    if raw.get('schema') != 'books.stock.input.v1':
        raise ValueError('invalid_input_schema')
    out = empty()
    for market in ['a', 'us']:
        batch = raw.get('markets', {}).get(market)
        if not batch:
            continue
        if batch.get('market') != market:
            raise ValueError('market_mismatch')
        source = batch.get('source', {})
        safe_source = {k:source[k] for k in SOURCE_KEYS if k in source}
        if not public_audience(raw) or not public_source(source):
            out['markets'][market] = dict(status='restricted', asOf=None, source=safe_source,
                                          rows=[], completeUniverse=False)
            continue
        if source.get('stopped') or source.get('errorCode'):
            old = (previous or {}).get('markets', {}).get(market, {})
            # A failed new fetch cannot turn an owner-only or unlicensed cache public.
            if (not public_audience(previous or {})
                    or old.get('rows') and not public_source(old.get('source') or {})):
                out['markets'][market] = dict(status='restricted', asOf=None, source=safe_source,
                                              rows=[], completeUniverse=False)
                continue
            out['markets'][market] = {**out['markets'][market], **old, 'status':'stale' if old.get('rows') else 'unavailable',
                                      'source':{**(old.get('source') or {}), **safe_source}}
            out['markets'][market].setdefault('rows', [])
            continue
        result = screen(batch, now)
        result['source'] = safe_source
        out['markets'][market] = result
    allowed = {m for m,v in out['markets'].items() if v['status'] in ['ready','partial']}
    obs = [x for x in raw.get('observations', []) if x.get('market') in allowed]
    # Public output contains factual quote fields only; unknown provider fields never pass through.
    fields = ['market','symbol','name','sourceTime','receivedAt','price','turnover','currency',
              'priceChange1m','source','session','minute','date']
    out['observations'] = [{k:x[k] for k in fields if k in x} for x in obs[-2000:]]
    out['alerts'] = anomalies(obs, now)[:500]
    out['version'] = hashlib.sha256(json.dumps(out, sort_keys=True).encode()).hexdigest()[:16]
    return out


def write(path, value):
    encoded = json.dumps(value, ensure_ascii=False, separators=(',', ':'))+'\n'
    if len(encoded.encode('utf-8')) > 8_000_000:
        raise ValueError('public_result_too_large_split_required')
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix+'.tmp')
    temporary.write_text(encoded)
    os.replace(temporary, path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path)
    parser.add_argument('--previous', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--empty', action='store_true')
    args = parser.parse_args()
    if args.empty == bool(args.input):
        parser.error('choose exactly one of --input or --empty')
    if args.input and args.input.stat().st_size > 250_000_000:
        raise ValueError('input_too_large')
    previous = json.loads(args.previous.read_text()) if args.previous else None
    value = empty() if args.empty else build(json.loads(args.input.read_text()), previous)
    write(args.output, value)
    print(json.dumps(dict(schema=value['schema'], output=str(args.output),
                         markets={k:v['status'] for k,v in value['markets'].items()}, ordersSent=0)))


if __name__ == '__main__':
    main()
