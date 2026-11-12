"""Bounded dry-run intent observer. It cannot sign or send an exchange order."""
import argparse
import base64
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'binance_watch'))
import public_orders as public

CHECKPOINT='https://api.github.com/repos/sking-3/xuanliu-site/contents/monitor-state/5075281354358777856.json?ref=binance-public-orders-state'
TARGETS=('Bitget','Binance','Hyperliquid')
FIELDS={'schemaVersion','mode','liveTradingEnabled','source','target','copyRatio','notionalPerIncrease','maxOrderNotional','maxTotalNotional','leverage','slippageBps','direction','symbols','signalMaxAgeSeconds'}

def validate_config(c):
    def require(ok):
        if not ok:raise ValueError('invalid_dry_run_config')
    require(isinstance(c,dict) and set(c)==FIELDS and type(c['schemaVersion']) is int and c['schemaVersion']==1 and c['mode']=='dry_run' and c['liveTradingEnabled'] is False)
    require(c['source']=={'exchange':'Binance','accountId':'5075281354358777856'})
    require(isinstance(c['target'],dict) and set(c['target'])=={'exchange','accountRef'} and c['target']['exchange'] in TARGETS)
    import re
    require(isinstance(c['target']['accountRef'],str) and bool(re.fullmatch('[A-Z][A-Z0-9_]{2,31}',c['target']['accountRef'])))
    for key,low,high in [('copyRatio',.001,10),('notionalPerIncrease',1,1e6),('maxOrderNotional',1,1e6),('maxTotalNotional',1,1e7),('leverage',1,40),('slippageBps',0,500),('signalMaxAgeSeconds',5,120)]:
        require(type(c[key]) in (int,float) and low<=c[key]<=high)
    require(type(c['leverage']) is int and c['notionalPerIncrease']*c['copyRatio']<=c['maxOrderNotional']<=c['maxTotalNotional'])
    require(c['direction'] in ('both','long','short') and isinstance(c['symbols'],list) and len(c['symbols'])<=20 and all(isinstance(x,str) and re.fullmatch('[A-Z0-9_]{2,30}',x) for x in c['symbols']))
    return c

def config_id(c):return hashlib.sha256(json.dumps(validate_config(c),sort_keys=True,separators=(',',':')).encode()).hexdigest()

def advance(c,previous,checkpoint,now):
    validate_config(c);public.validate_state(checkpoint)
    digest=config_id(c)
    if previous and previous.get('stopped'):raise ValueError('persisted_dry_run_stop')
    checked=public.stamp(checkpoint['lastSuccessAt']) if checkpoint['lastSuccessAt'] else 0
    if checkpoint['stopped'] or not checkpoint['initialized'] or checked>now+1 or now-checked>120:raise ValueError('source_not_healthy')
    rows=checkpoint['records'];state=copy.deepcopy(previous) if previous else None
    if state and (state.get('schemaVersion')!=1 or state.get('configId')!=digest or not isinstance(state.get('seen'),list) or len(state['seen'])>4000 or len(set(state['seen']))!=len(state['seen']) or not isinstance(state.get('identities'),dict) or len(state['identities'])>4000 or not all(type(state.get(k)) in (int,float) and math.isfinite(state[k]) for k in ('lastTick','lastSourceAt','startedAt'))):raise ValueError('invalid_dry_run_state')
    for r in rows.values():
        verified=public.record(r,r['firstSeenAt'])
        if any(r.get(k)!=verified[k] for k in ('fingerprint','direction','sourceCreatedAt','sourceUpdatedAt')):raise ValueError('source_record_metadata_mismatch')
    if not state or now-state['lastTick']>120 or now<state['lastTick']:
        return {'schemaVersion':1,'configId':digest,'startedAt':now,'lastTick':now,'lastSourceAt':checked,'seen':list(rows),'identities':{r['identity']:k for k,r in rows.items()},'stopped':False},[],{'status':'baseline','records':len(rows)}
    if checked<state['lastSourceAt']:raise ValueError('source_time_rollback')
    identities={}
    for r in rows.values():identities[r['identity']]=identities.get(r['identity'],0)+1
    plans=[]
    for key,r in sorted(rows.items(),key=lambda kv:(kv[1]['orderUpdateTime'],kv[0])):
        if key in state['seen']:continue
        source_time=r['orderUpdateTime']/1000;first=public.stamp(r.get('versionFirstSeenAt',r['firstSeenAt']))
        reason=None;direction=r['direction'];side='long' if direction.endswith('_long') else 'short' if direction.endswith('_short') else None
        if float(r['executedQty'])<=0 or float(r['avgPrice'])<=0:reason='no_executed_quantity_or_price'
        elif source_time<=state['startedAt'] or first<state['startedAt']:reason='historical_or_late'
        elif source_time>now+1 or first>now+1 or now-source_time>c['signalMaxAgeSeconds']:reason='signal_time_invalid_or_stale'
        elif identities[r['identity']]>1 or r['identity'] in state['identities'] and state['identities'][r['identity']]!=key:reason='ambiguous_record_version'
        elif side is None:reason='direction_unresolved'
        elif c['direction'] not in ('both',side):reason='direction_filtered'
        elif c['symbols'] and r['symbol'] not in c['symbols']:reason='symbol_filtered'
        increase=direction.startswith('opening_or_increasing_')
        plans.append({'sourceFingerprint':key,'sourceTime':r['sourceUpdatedAt'],'firstSeenAt':r.get('versionFirstSeenAt',r['firstSeenAt']),'sourceSymbol':r['symbol'],'sourceQuantity':r['executedQty'],'target':c['target'],'direction':side,'intent':'increase_fragment' if increase else 'reduce_owned_fragment_only','requestedNotional':c['notionalPerIncrease']*c['copyRatio'] if increase and not reason else None,'constraints':{k:c[k] for k in ('maxOrderNotional','maxTotalNotional','leverage','slippageBps')},'quoteUnit':'USDC' if c['target']['exchange']=='Hyperliquid' else 'USDT','status':'skipped' if reason else 'dry_run_intent','reason':reason,'executable':False,'quantity':None,'price':None,'requires':['target_market_mapping','fresh_order_book','size_precision_and_minimum','account_permissions','owned_position_and_margin','idempotent_order_reconciliation'],'ordersSent':0})
        state['seen'].append(key);state['identities'][r['identity']]=key
    if len(state['seen'])>4000:raise ValueError('dry_run_state_full')
    state.update(lastTick=now,lastSourceAt=checked)
    return state,plans,{'status':'observed','newRecords':len(plans)}

def read_checkpoint(token):
    req=urllib.request.Request(CHECKPOINT,headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json','User-Agent':'BooksCopyDryRun/1.0'})
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),public.monitor.NoRedirect())
    try:
        with opener.open(req,timeout=10) as response:
            raw=response.read(2000000)
            if len(raw)>=2000000:raise ValueError('checkpoint_too_large')
    except urllib.error.HTTPError as e:
        code=e.code;e.close();raise ValueError('github_checkpoint_http_'+str(code)) from None
    envelope=json.loads(raw);return json.loads(base64.b64decode(envelope['content'].replace('\n',''),validate=True))

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--config',type=Path,required=True);parser.add_argument('--state',type=Path,required=True);parser.add_argument('--report',type=Path,required=True);parser.add_argument('--duration',type=int,default=65);args=parser.parse_args()
    report={'mode':'dry_run','liveTradingEnabled':False,'ordersSent':0,'plans':[],'checks':[]}
    state=None;c=None
    try:
        config_path=args.config.resolve();allowed=(Path.cwd()/'copy-config').resolve()
        if allowed not in config_path.parents or args.duration not in range(1,121):raise ValueError('invalid_config_path_or_duration')
        c=validate_config(json.loads(config_path.read_text()));state=json.loads(args.state.read_text()) if args.state.exists() else None
        if state and state.get('stopped'):raise ValueError('persisted_dry_run_stop')
        token=os.environ.get('GITHUB_TOKEN')
        if not token:raise ValueError('github_token_missing')
        end=time.monotonic()+args.duration;target=time.monotonic()
        while target<end:
            time.sleep(max(0,target-time.monotonic()))
            if time.monotonic()>=end:break
            checkpoint=read_checkpoint(token);state,plans,check=advance(c,state,checkpoint,time.time());report['plans'].extend(plans);report['checks'].append(check);args.state.parent.mkdir(parents=True,exist_ok=True);args.state.write_text(json.dumps(state));target+=5
            while target<=time.monotonic():target+=5
        report['status']='completed'
    except Exception as e:
        # Exception bodies/HTTP payloads are never logged. This workflow reads no exchange credentials.
        code=str(e) if isinstance(e,ValueError) and str(e).replace('_','').isalnum() else type(e).__name__
        report.update(status='stopped',errorCode=code)
        if c:
            state=state or {'schemaVersion':1,'configId':config_id(c)}
            state.update(stopped=True,errorCode=code);args.state.parent.mkdir(parents=True,exist_ok=True);args.state.write_text(json.dumps(state))
    args.report.parent.mkdir(parents=True,exist_ok=True);args.report.write_text(json.dumps(report,indent=2));print(json.dumps({k:v for k,v in report.items() if k not in ('plans','checks')}))
    return 0 if report['status']=='completed' else 2
if __name__=='__main__':sys.exit(main())
