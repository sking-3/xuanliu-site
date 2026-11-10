import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from screen_research import a_rows, us_rows

class Screens(unittest.TestCase):
    def test_independent_signals_merge(self):
        p=dict(min_price=5,min_turnover=100,event_gap=.1,event_volume=2,break_volume=1.5,max_extension=.15,near_high=.03)
        m=dict(close=105,turnover=1000,gap=.12,rvol=3,dayret=.08,ma20=100,ma50=90,high20=104,excess=.05,ma50_up=True,asof='2026-11-06')
        snap=dict(asof=m['asof'],params=p,stocks=[dict(ticker='TEST',name='fixture',m=m)])
        self.assertEqual(us_rows(snap)['rows'][0]['hits'],['U1','U2'])
        m['asof']='2026-11-05'
        self.assertEqual(us_rows(snap)['rows'][0]['status'],'待核')

    def test_partial_geometry_cannot_qualify(self):
        base=dict(as_of_date='2026-11-05',geometric_result=dict(status_code='IN_ZONE_RECLAIM',geometric_observation_only=True))
        rows=[dict(base,symbol=s,name=n) for s,n in [('600001','样本'),('000002','*ST样本'),('300001','样本'),('600003','某某退')]]
        result=a_rows(dict(schema_version='books.screening.view.v1',rows=rows,as_of_date='2026-11-05',source={'filename':'fixture'}))
        self.assertEqual([r['status'] for r in result['rows']],['待核','排除','排除','排除'])
        self.assertEqual(result['rows'][0]['hits'],['F1'])

if __name__=='__main__':unittest.main()
