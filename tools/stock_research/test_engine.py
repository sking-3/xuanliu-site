"""Synthetic fixtures only: never published as quotes or trading candidates."""
import copy
import json
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from tools.stock_research import engine as e, adapters as a, pipeline as p

DAY='2026-11-12'
NOW=e.stamp('2026-11-13T01:00:00Z')

def batch(market='us'):
    bars=[]
    for i in range(61):
        close=95+i*.1
        bars.append(dict(date=(date.fromisoformat(DAY)-timedelta(days=60-i)).isoformat(),
                         open=close,high=close+.1,low=close-.1,close=close,volume=100000,turnover=20000000))
    bars[-1].update(open=106,high=106.1,low=104.9,close=105,volume=300000)
    eligibility=dict(asOf=DAY,exchange='NASDAQ' if market=='us' else 'SSE',board='main',assetType='ordinary_stock',
                     isST=False,riskWarning=False,delisted=False,suspended=False,normalLimitVerified=True,limitPct=10)
    return dict(market=market,session=dict(date=DAY,calendarVerified=True,closeTime='2026-11-12T21:00:00Z' if market=='us' else '2026-11-12T07:00:00Z',tradingDates=[b['date'] for b in bars]),
                source=dict(id='offline_fixture',name='Synthetic test source',permissionsVerified=True,redistributionAllowed=True,
                            dataAsOf=DAY,receivedAt='2026-11-12T21:30:00Z' if market=='us' else '2026-11-12T07:30:00Z',coverage='full_universe',expectedCount=1,paginationComplete=True,feed='sip'),
                securities=[dict(symbol='FIXTURE' if market=='us' else '600001',name='Synthetic fixture',eligibility=eligibility,
                                 adjustmentVerified=True,bars=bars)],benchmark=[dict(date=b['date'],close=100) for b in bars])

def observation():
    return dict(market='us',symbol='FIXTURE',source='offline_fixture',currency='USD',date=DAY,minute='19:59',session='post',
                sourceTime='2026-11-13T00:59:30Z',receivedAt='2026-11-13T00:59:31Z',price=100,turnover=400,priceChange1m=.02,
                baseline=[dict(date=(date.fromisoformat(DAY)-timedelta(days=i)).isoformat(),minute='19:59',session='post',turnover=100) for i in range(1,11)])

def official_event(b):
    """Synthetic causal source evidence; no real issuer announcement is claimed."""
    b['session']['openTime']='2026-11-12T14:30:00Z'
    b['securities'][0]['event']=dict(symbol='FIXTURE',kind='earnings',officialVerified=True,
        sourceType='sec',sourceUrl='https://www.sec.gov/Archives/SYNTHETIC_TEST_ONLY',
        publishedAt='2026-11-12T12:00:00Z',firstSeenAt='2026-11-12T12:00:01Z',
        receivedAt='2026-11-12T12:00:02Z')
    return b

class Research(unittest.TestCase):
    def test_independent_rules_merge_and_exclude_current_high(self):
        b=batch();result=e.screen(b,NOW);r=result['rows'][0]
        self.assertEqual(result['rulesVersion'],'books.stock.us.causal.v2')
        self.assertEqual(r['hits'],['U1','U2']);self.assertEqual(r['status'],'candidate')
        self.assertLess(r['metrics']['high20'],r['close']);self.assertIn('event_catalyst_requires_evidence',r['reasons'])
        self.assertEqual(r['pending'],['U1'])
        self.assertEqual(r['eligibleHits'],['U2'])

    def test_near_breakout_is_independent(self):
        b=batch();last=b['securities'][0]['bars'][-1];last.update(open=100.8,close=100.8,low=100.7,high=100.9,volume=100000)
        r=e.screen(b,NOW)['rows'][0]
        self.assertEqual(r['hits'],['U3']);self.assertEqual(r['status'],'pending')
        self.assertEqual(r['pending'],['U3']);self.assertIn('near_breakout_watch_only',r['reasons'])
        self.assertEqual(r['eligibleHits'],[])

    def test_u1_shape_without_causal_official_event_stays_pending_without_blocking_independent_u2(self):
        b=batch();b['benchmark']=[]
        r=e.screen(b,NOW)['rows'][0]
        self.assertEqual(r['hits'],['U1']);self.assertEqual(r['status'],'pending')
        self.assertEqual(r['pending'],['U1']);self.assertIn('event_catalyst_requires_evidence',r['reasons'])
        self.assertEqual(r['eligibleHits'],[])
        self.assertEqual(e.screen(batch(),NOW)['rows'][0]['status'],'candidate')
        b=official_event(batch());b['benchmark']=[]
        r=e.screen(b,NOW)['rows'][0]
        self.assertEqual(r['hits'],['U1']);self.assertEqual(r['status'],'candidate')
        self.assertEqual(r['pending'],[])
        self.assertEqual(r['eligibleHits'],['U1'])

    def test_u1_event_identity_original_source_and_opening_causality_are_verified_before_promotion(self):
        changes=[lambda b:b['securities'][0]['event'].update(symbol='OTHER'),
                 lambda b:b['securities'][0]['event'].update(kind='rumour'),
                 lambda b:b['securities'][0]['event'].update(officialVerified=1),
                 lambda b:b['securities'][0]['event'].update(sourceType='social'),
                 lambda b:b['securities'][0]['event'].update(sourceUrl='http://www.sec.gov/filing'),
                 lambda b:b['securities'][0]['event'].update(sourceUrl='https://user:secret@www.sec.gov/filing'),
                 lambda b:b['securities'][0]['event'].update(sourceUrl='https://www.sec.gov:not-a-port/filing'),
                 lambda b:b['securities'][0]['event'].update(publishedAt='2026-11-12T14:30:00Z',firstSeenAt='2026-11-12T14:30:01Z',receivedAt='2026-11-12T14:30:02Z'),
                 lambda b:b['securities'][0]['event'].update(publishedAt='2026-11-12T22:00:00Z',firstSeenAt='2026-11-12T22:00:01Z',receivedAt='2026-11-12T22:00:02Z'),
                 lambda b:b['securities'][0]['event'].update(firstSeenAt='2026-11-12T11:59:59Z'),
                 lambda b:b['securities'][0]['event'].update(receivedAt='2026-11-12T21:30:01Z'),
                 lambda b:b['securities'][0]['event'].update(receivedAt='2026-11-13T02:00:00Z'),
                 lambda b:b['session'].pop('openTime'),
                 lambda b:b['session'].update(openTime='2026-11-11T14:30:00Z')]
        for index,change in enumerate(changes):
            with self.subTest(index=index):
                b=official_event(batch());b['benchmark']=[];change(b)
                r=e.screen(b,NOW)['rows'][0]
                self.assertEqual(r['status'],'pending');self.assertEqual(r['hits'],['U1'])
                self.assertEqual(r['pending'],['U1'])
        b=official_event(batch());b['securities'][0]['event'].update(kind='guidance',sourceType='issuer',sourceUrl='https://issuer.example/SYNTHETIC_TEST_ONLY')
        b['benchmark']=[]
        self.assertEqual(e.screen(b,NOW)['rows'][0]['status'],'candidate')

    def test_unverified_calendar_never_produces_quotes_metrics_or_shape_hits(self):
        for value in [False,None,1]:
            with self.subTest(calendarVerified=value):
                b=batch();b['session']['calendarVerified']=value;r=e.screen(b,NOW)['rows'][0]
                self.assertEqual(r['status'],'pending');self.assertEqual(r['hits'],[])
                self.assertIsNone(r['close']);self.assertIsNone(r['metrics']);self.assertEqual(r['bars'],[])
                self.assertIn('complete_close_or_calendar_unverified',r['reasons'])

    def test_finite_raw_values_cannot_publish_nonfinite_derived_metrics(self):
        for mutation in ['volume','gap','relative']:
            with self.subTest(mutation=mutation):
                b=batch();bars=b['securities'][0]['bars']
                if mutation=='volume':
                    for bar in bars[:-1]:bar['volume']=1e-300
                    bars[-1]['volume']=1e308
                elif mutation=='gap':
                    for key in ['open','high','low','close']:bars[-2][key]=1e-310
                else:
                    b['benchmark'][-21]['close']=1e-300;b['benchmark'][-1]['close']=1e308
                r=e.screen(b,NOW)['rows'][0]
                self.assertEqual(r['status'],'pending');self.assertEqual(r['hits'],[])
                self.assertIsNone(r['metrics']);self.assertIn('derived_metrics_invalid',r['reasons'])
                json.dumps(r,allow_nan=False)

    def test_no_incomplete_batch_promotes_candidate(self):
        for field,value in [('paginationComplete',False),('permissionsVerified',False),('coverage','watchlist'),('feed','iex'),('dataAsOf','2026-11-11'),('expectedCount',2),('expectedCount',True)]:
            b=batch();b['source'][field]=value
            with self.subTest(field=field):
                result=e.screen(b,NOW);self.assertEqual(result['status'],'partial');self.assertEqual(result['rows'][0]['status'],'pending')
                self.assertEqual(result['rows'][0]['eligibleHits'],[])
        b=batch();b['session']['closeTime']='2026-11-14T21:00:00Z';self.assertEqual(e.screen(b,NOW)['status'],'partial')

    def test_a_qualification_and_unconfirmed_modes(self):
        b=batch('a');r=e.screen(b,NOW)['rows'][0]
        self.assertEqual(r['qualification'],'qualified');self.assertEqual(r['status'],'pending');self.assertEqual(r['hits'],[]);self.assertEqual(len(r['pending']),5)
        for field,value,status in [('isST',True,'excluded'),('suspended',True,'excluded'),('riskWarning',None,'pending'),('limitPct',20,'pending'),('asOf','2026-11-11','pending')]:
            s=copy.deepcopy(b['securities'][0]);s['eligibility'][field]=value
            with self.subTest(field=field):self.assertEqual(e.qualification(s,'a',DAY)[0],status)

    def test_invalid_adjustment_dates_and_benchmark(self):
        for mutation,reason in [(lambda s:s.update(adjustmentVerified=False),'adjustment_or_history_incomplete'),(lambda s:s['bars'].append(copy.deepcopy(s['bars'][-1])),'bar_dates_incomplete'),(lambda s:s['bars'][-1].update(high=90),'bar_values_invalid')]:
            b=batch();mutation(b['securities'][0]);self.assertIn(reason,e.screen(b,NOW)['rows'][0]['reasons'])
        b=batch();b['benchmark']=[];r=e.screen(b,NOW)['rows'][0];self.assertEqual(r['hits'],['U1']);self.assertIn('same_date_spy_benchmark_missing',r['reasons'])
        b=batch();b['session']['tradingDates']=[];self.assertIn('trading_calendar_history_incomplete',e.screen(b,NOW)['rows'][0]['reasons'])

    def test_unverified_close_and_receipt_times_cannot_publish_signal_values(self):
        cases = [
            ('market_close_date_mismatch', 'closeTime', '2026-11-11T21:00:00Z'),
            ('market_close_in_future', 'closeTime', '2026-11-14T21:00:00Z'),
            ('source_received_in_future', 'receivedAt', '2026-11-13T02:00:00Z'),
            ('source_received_before_close', 'receivedAt', '2026-11-12T20:59:59Z'),
        ]
        for reason, field, value in cases:
            b=batch()
            (b['session'] if field=='closeTime' else b['source'])[field]=value
            with self.subTest(reason=reason):
                result=e.screen(b,NOW);row=result['rows'][0]
                self.assertEqual(result['status'],'partial')
                self.assertFalse(result['completeUniverse'])
                self.assertEqual(row['status'],'pending')
                self.assertIn(reason,row['reasons'])
                self.assertEqual(row['hits'],[])
                self.assertIsNone(row['close'])
                self.assertIsNone(row['metrics'])

    def test_future_bars_with_a_previous_close_time_do_not_pass_before_the_session(self):
        b=batch();b['session']['closeTime']='2026-11-11T21:00:00Z'
        result=e.screen(b,e.stamp('2026-11-12T12:00:00Z'))
        self.assertEqual(result['rows'][0]['status'],'pending')
        self.assertEqual(result['rows'][0]['hits'],[])
        self.assertIn('market_close_date_mismatch',result['rows'][0]['reasons'])
        self.assertIn('source_received_in_future',result['rows'][0]['reasons'])

    def test_market_timezone_matches_session_date_without_assuming_a_fixed_us_close(self):
        us=batch();us['session']['closeTime']='2026-11-12T16:00:00-05:00'
        us['source']['receivedAt']='2026-11-12T16:30:00-05:00'
        self.assertEqual(e.screen(us,NOW)['status'],'ready')
        # Synthetic verified calendar input: early-close timestamps remain accepted.
        us['session']['closeTime']='2026-11-12T13:00:00-05:00'
        self.assertEqual(e.screen(us,NOW)['status'],'ready')
        a_batch=batch('a');self.assertEqual(e.screen(a_batch,NOW)['status'],'ready')
        a_batch['session']['closeTime']='2026-11-12T21:00:00Z'
        row=e.screen(a_batch,NOW)['rows'][0]
        self.assertIn('market_close_date_mismatch',row['reasons'])
        self.assertIsNone(row['close'])

    def test_benchmark_duplicates_are_rejected_before_they_change_relative_strength(self):
        b=batch();b['benchmark']=[dict(date=b['session']['tradingDates'][-21],close=100),dict(date=DAY,close=110)]
        self.assertEqual(e.screen(b,NOW)['rows'][0]['hits'],['U1'])
        for duplicate_close in [110,1]:
            q=copy.deepcopy(b);q['benchmark'].append(dict(date=DAY,close=duplicate_close))
            with self.subTest(close=duplicate_close):
                with self.assertRaisesRegex(ValueError,'duplicate_benchmark_date'):e.screen(q,NOW)
        for value in [0,float('nan')]:
            q=copy.deepcopy(b);q['benchmark'][-1]['close']=value
            with self.assertRaisesRegex(ValueError,'benchmark_values_invalid'):e.screen(q,NOW)

    def test_anomaly_baseline_dedup_age_session_and_order(self):
        x=observation();events=e.anomalies([x,x],NOW);self.assertEqual(len(events),1);self.assertEqual(events[0]['ratio'],4);self.assertEqual(events[0]['level'],'confirmed')
        for change in ['stale','duplicate_day','wrong_session','low_volume']:
            q=copy.deepcopy(x)
            if change=='stale':q['sourceTime']='2026-11-12T23:59:30Z';q['minute']='18:59'
            elif change=='duplicate_day':q['baseline'].append(q['baseline'][0])
            elif change=='wrong_session':q['baseline'][0]['session']='pre'
            else:q['turnover']=200
            with self.subTest(change=change):self.assertEqual(e.anomalies([q],NOW),[])
        q=copy.deepcopy(x);q['baseline'].reverse();self.assertEqual(e.anomalies([q],NOW)[0]['ratio'],4)

    def test_overflowing_activity_ratio_cannot_erase_valid_observations_or_enter_output(self):
        valid=observation();bad=copy.deepcopy(valid);bad['symbol']='OVERFLOW_FIXTURE';bad['turnover']=1e308
        for row in bad['baseline']:row['turnover']=1e-300
        events=e.anomalies([bad,valid],NOW)
        self.assertEqual(len(events),1);self.assertEqual(events[0]['symbol'],'FIXTURE')
        json.dumps(events,allow_nan=False)

    def test_pipeline_permissions_and_failure_retention(self):
        b=batch();raw=dict(schema='books.stock.input.v1',markets={'us':b},observations=[]);previous=p.build(raw,now=NOW)
        b['source'].update(stopped=True,errorCode='http_429');out=p.build(raw,previous,NOW)
        self.assertEqual(out['markets']['us']['status'],'stale');self.assertEqual(out['markets']['us']['rows'],previous['markets']['us']['rows'])
        initial_failure=p.build(raw,now=NOW)['markets']['us'];self.assertEqual(initial_failure['status'],'unavailable');self.assertIsNone(initial_failure['asOf'])
        b['source'].pop('stopped');b['source'].pop('errorCode');b['source']['redistributionAllowed']=False
        out=p.build(raw,now=NOW);self.assertEqual(out['markets']['us']['status'],'restricted');self.assertEqual(out['markets']['us']['rows'],[])

    def test_failed_us_refresh_retains_original_evidence_but_downgrades_old_rule_candidates(self):
        raw=dict(schema='books.stock.input.v1',markets={'us':batch()})
        previous=p.build(raw,now=NOW)
        raw['markets']['us']['source']['errorCode']='http_429'
        for version in [None,'legacy-us-rules-v1']:
            old=copy.deepcopy(previous)
            if version is None:old['markets']['us'].pop('rulesVersion')
            else:old['markets']['us']['rulesVersion']=version
            old_row=old['markets']['us']['rows'][0]
            old_row['userNote']={'label':'SYNTHETIC retained user note'}
            before=copy.deepcopy(old)
            result=p.build(raw,old,NOW)['markets']['us'];row=result['rows'][0]
            with self.subTest(version=version):
                self.assertEqual(result['status'],'stale')
                self.assertEqual(result.get('rulesVersion'),version)
                self.assertEqual(result['asOf'],old['markets']['us']['asOf'])
                self.assertEqual(row['status'],'pending');self.assertEqual(row['previousRulesStatus'],'candidate')
                self.assertEqual(row['eligibleHits'],[])
                self.assertIn('us_rules_recompute_required',row['reasons'])
                for field in ['close','hits','metrics','bars','asOf','userNote']:
                    self.assertEqual(row[field],old_row[field])
                self.assertEqual(old,before)
                again=p.build(raw,dict(markets={'us':result}),NOW)['markets']['us']['rows'][0]
                self.assertEqual(again,row)

    def test_failed_us_refresh_rejects_false_current_version_candidate_eligibility(self):
        raw=dict(schema='books.stock.input.v1',markets={'us':batch()})
        previous=p.build(raw,now=NOW)
        raw['markets']['us']['source']['errorCode']='http_403'
        for eligible in [None,[],['U3'],['U2','U3'],['U2','U2'],['U1'],'U2',[{}]]:
            old=copy.deepcopy(previous);row=old['markets']['us']['rows'][0]
            if eligible is None:row.pop('eligibleHits')
            else:row['eligibleHits']=eligible
            before=copy.deepcopy(old)
            result=p.build(raw,old,NOW)['markets']['us']
            with self.subTest(eligible=eligible):
                self.assertEqual(result['status'],'stale')
                self.assertEqual(result['rulesVersion'],e.US_RULES_VERSION)
                self.assertEqual(result['rows'][0]['status'],'pending')
                self.assertEqual(result['rows'][0]['eligibleHits'],[])
                self.assertEqual(result['rows'][0]['previousRulesStatus'],'candidate')
                self.assertIn('us_rules_recompute_required',result['rows'][0]['reasons'])
                self.assertEqual(old,before)
        # A genuine current U2 candidate survives a source failure, independently
        # of its U1 shape still awaiting official event evidence.
        retained=p.build(raw,previous,NOW)['markets']['us']
        self.assertEqual(retained['rows'],previous['markets']['us']['rows'])
        self.assertEqual(retained['rows'][0]['status'],'candidate')
        self.assertEqual(retained['rows'][0]['eligibleHits'],['U2'])
        old=copy.deepcopy(previous);old['markets']['us']['rows'][0]['hits']=['U1']
        self.assertEqual(p.build(raw,old,NOW)['markets']['us']['rows'][0]['status'],'pending')

    def test_failed_a_refresh_does_not_apply_the_us_version_boundary(self):
        raw=dict(schema='books.stock.input.v1',markets={'a':batch('a')})
        previous=p.build(raw,now=NOW)
        previous['markets']['a']['rows'][0]['userNote']='SYNTHETIC retained A note'
        before=copy.deepcopy(previous)
        raw['markets']['a']['source']['errorCode']='http_429'
        result=p.build(raw,previous,NOW)['markets']['a']
        self.assertEqual(result['status'],'stale')
        self.assertEqual(result['rows'],before['markets']['a']['rows'])
        self.assertNotIn('rulesVersion',result)
        self.assertNotIn('previousRulesStatus',result['rows'][0])
        self.assertEqual(previous,before)

    def test_failed_source_cannot_publish_a_private_or_unlicensed_previous_snapshot(self):
        raw=dict(schema='books.stock.input.v1',markets={'us':batch()},observations=[])
        previous=p.build(raw,now=NOW)
        raw['markets']['us']['source'].update(errorCode='http_403')
        for privacy in ['owner','personal_scope','no_redistribution']:
            old=copy.deepcopy(previous)
            old['markets']['us']['rows'][0]['name']='OWNER_ONLY_TEST_MARKER'
            if privacy=='owner':old['audience']='owner'
            elif privacy=='personal_scope':old['markets']['us']['source']['accessScope']='personal'
            else:old['markets']['us']['source']['redistributionAllowed']=False
            with self.subTest(privacy=privacy):
                result=p.build(raw,old,NOW)
                self.assertEqual(result['markets']['us']['status'],'restricted')
                self.assertEqual(result['markets']['us']['rows'],[])
                self.assertNotIn('OWNER_ONLY_TEST_MARKER',json.dumps(result))
                self.assertEqual(result['markets']['us']['source']['errorCode'],'http_403')
        # A failed fetch still preserves last-good data that already has public rights.
        self.assertEqual(p.build(raw,previous,NOW)['markets']['us']['rows'],previous['markets']['us']['rows'])

    def test_private_current_or_revoked_rights_restrict_even_the_failure_path(self):
        raw=dict(schema='books.stock.input.v1',markets={'us':batch()})
        previous=p.build(raw,now=NOW)
        for field,value in [('redistributionAllowed',False),('accessScope','personal')]:
            current=copy.deepcopy(raw);current['markets']['us']['source'].update(errorCode='http_429')
            current['markets']['us']['source'][field]=value
            result=p.build(current,previous,NOW)
            self.assertEqual(result['markets']['us']['status'],'restricted')
            self.assertEqual(result['markets']['us']['rows'],[])
        raw['audience']='owner'
        self.assertEqual(p.build(raw,previous,NOW)['markets']['us']['status'],'restricted')

    def test_publication_requires_verified_permissions_for_full_and_partial_batches(self):
        for coverage in ['full_universe','watchlist']:
            raw=dict(schema='books.stock.input.v1',markets={'us':batch()},observations=[observation()])
            raw['markets']['us']['source']['coverage']=coverage
            allowed=p.build(raw,now=NOW)
            self.assertEqual(allowed['markets']['us']['status'],'ready' if coverage=='full_universe' else 'partial')
            self.assertEqual(len(allowed['markets']['us']['rows']),1)
            self.assertEqual(len(allowed['observations']),1)
            for verified in [False,None,1]:
                denied=copy.deepcopy(raw)
                if verified is None:denied['markets']['us']['source'].pop('permissionsVerified')
                else:denied['markets']['us']['source']['permissionsVerified']=verified
                with self.subTest(coverage=coverage,verified=verified):
                    result=p.build(denied,now=NOW)
                    self.assertEqual(result['markets']['us']['status'],'restricted')
                    self.assertEqual(result['markets']['us']['rows'],[])
                    self.assertEqual(result['observations'],[])
                    self.assertEqual(result['alerts'],[])

    def test_failed_source_requires_verified_current_and_cached_public_permissions(self):
        raw=dict(schema='books.stock.input.v1',markets={'us':batch()},observations=[observation()])
        previous=p.build(raw,now=NOW)
        raw['markets']['us']['source']['errorCode']='http_403'
        for target in ['current','previous']:
            for verified in [False,None]:
                current,old=copy.deepcopy(raw),copy.deepcopy(previous)
                source=(current if target=='current' else old)['markets']['us']['source']
                if verified is None:source.pop('permissionsVerified')
                else:source['permissionsVerified']=verified
                with self.subTest(target=target,verified=verified):
                    result=p.build(current,old,NOW)
                    self.assertEqual(result['markets']['us']['status'],'restricted')
                    self.assertEqual(result['markets']['us']['rows'],[])
                    self.assertEqual(result['observations'],[])
                    self.assertEqual(result['alerts'],[])
                    self.assertEqual(result['markets']['us']['source']['errorCode'],'http_403')
        retained=p.build(raw,previous,NOW)
        self.assertEqual(retained['markets']['us']['status'],'stale')
        self.assertEqual(retained['markets']['us']['rows'],previous['markets']['us']['rows'])
        self.assertEqual(retained['markets']['us']['asOf'],previous['markets']['us']['asOf'])
        self.assertIs(retained['markets']['us']['source']['permissionsVerified'],True)

    def test_schema_time_errors_leave_last_good_file_unchanged(self):
        raw=dict(schema='books.stock.input.v1',markets={'us':batch()})
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'snapshot.json';p.write(path,p.build(raw,now=NOW));before=path.read_bytes()
            raw['markets']['us']['source']['receivedAt']='2026-11-12T21:30:00'
            with self.assertRaisesRegex(ValueError,'timezone_required'):
                p.write(path,p.build(raw,now=NOW))
            self.assertEqual(path.read_bytes(),before)

    def test_public_serialization_drops_unknown_provider_fields(self):
        b=official_event(batch());b['source']['token']='SYNTHETIC_SECRET';b['source']['url']='https://fixture.invalid/?token=SYNTHETIC_SECRET';b['securities'][0]['bars'][0]['secret']='SYNTHETIC_SECRET';b['securities'][0]['event']['unknownProviderField']='SYNTHETIC_SECRET'
        out=p.build(dict(schema='books.stock.input.v1',markets={'us':b}),now=NOW)
        self.assertNotIn('SYNTHETIC_SECRET',json.dumps(out));self.assertEqual(out['execution']['realOrdersSent'],0)

    def test_empty_and_atomic_output(self):
        out=p.empty();self.assertTrue(all(x['rows']==[] and x['status']=='not_configured' for x in out['markets'].values()))
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'data/snapshot.json';p.write(path,out);self.assertEqual(json.loads(path.read_text()),out);self.assertFalse(path.with_suffix('.json.tmp').exists())

    def test_nonfinite_serialization_never_overwrites_a_last_good_public_file(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'snapshot.json';p.write(path,p.empty());before=path.read_bytes()
            for value in [float('inf'),float('-inf'),float('nan')]:
                with self.subTest(value=value):
                    with self.assertRaises(ValueError):p.write(path,dict(price=value))
                    self.assertEqual(path.read_bytes(),before)
                    self.assertFalse(path.with_suffix('.json.tmp').exists())

class Adapters(unittest.TestCase):
    def test_a_units_and_latest_factor_anchor(self):
        fields=['ts_code','trade_date','open','high','low','close','vol','amount']
        raw=dict(code=0,data=dict(fields=fields,items=[['600001.SH','20261111',10,11,9,10,2,3],['600001.SH','20261112',5,6,4,5,2,3]]))
        factors=dict(code=0,data=dict(fields=['ts_code','trade_date','adj_factor'],items=[['600001.SH','20261111',1],['600001.SH','20261112',2]]))
        bars=a.a_daily(raw,factors)['600001.SH'];self.assertEqual(bars[0]['close'],5);self.assertEqual(bars[-1]['close'],5);self.assertEqual(bars[0]['volume'],200);self.assertEqual(bars[0]['turnover'],3000)
        factors['data']['items']=[]
        with self.assertRaisesRegex(ValueError,'factor_missing'):a.a_daily(raw,factors)
        with self.assertRaisesRegex(ValueError,'permission_denied_stop'):a.tushare_table(dict(code=2002))

    def test_us_pages_and_turnover(self):
        bar=dict(t='2026-11-12T05:00:00Z',o=10,h=11,l=9,c=10,v=20,vw=10)
        first=dict(bars={'FIXTURE':[bar]},next_page_token='next');last=dict(bars={},next_page_token=None)
        self.assertEqual(a.us_daily([first,last])['FIXTURE'][0]['turnover'],200)
        with self.assertRaisesRegex(ValueError,'pagination_incomplete'):a.us_daily([first])
        last['bars']={'FIXTURE':[bar]}
        with self.assertRaisesRegex(ValueError,'duplicate_bar'):a.us_daily([first,last])

if __name__=='__main__':unittest.main()
