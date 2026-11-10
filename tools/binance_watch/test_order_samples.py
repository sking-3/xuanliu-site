"""Offline source-shaped fixtures. No request is made to the target account."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import monitor as m
from test_monitor import Clock, FakeSource

T = 1770000000000
def page(*rows):
    return {"list": list(rows), "total": 200}
def order(key, ms, qty="0", updated=None):
    return {"orderId": key, "symbol": "BTCUSDT", "side": "BUY", "positionSide": "LONG",
            "orderTime": ms, "orderUpdateTime": updated or ms, "executedQty": qty}

class Orders(unittest.TestCase):
    def test_baseline_late_history_new_order_and_partial_execution(self):
        old = order("100", T-60000)
        state, events = m.order_samples(page(old), None, m.iso(T/1000), True)
        self.assertEqual(events, [])
        t = T+5000
        pending = order("101", T+2000)
        updated = order("100", T-60000, "2.5", T+3000)
        state, events = m.order_samples(page(updated,pending,order("99",T-30000),order(None,T)),state,m.iso(t/1000),False)
        self.assertEqual([x["kind"] for x in events],["executed_quantity_increased","new_public_order"])
        self.assertEqual(events[0]["firstSeenAt"],m.iso(T/1000))
        self.assertEqual(events[1]["sourceCreatedAt"],m.iso((T+2000)/1000))
        self.assertEqual(state["withoutIdentity"],1)
        m.validate_order_checkpoint(state)
        _, events = m.order_samples(page(updated,pending),state,m.iso((t+5000)/1000),False)
        self.assertEqual(events, [])
        _, events = m.order_samples(page(order("102",t+1)),state,m.iso((t+90000)/1000),True)
        self.assertEqual(events, [])

    def test_invalid_and_duplicate_input_keeps_old_checkpoint(self):
        state, _ = m.order_samples(page(order("1",T)),None,m.iso(T/1000),True)
        for broken in [page(order("2",T),order("2",T)),page(order("1",T+999999)),page(order("1",T,"-1"))]:
            with self.assertRaises(m.Stop):
                m.order_samples(broken,state,m.iso((T+5000)/1000),False)
        self.assertEqual(len(state["rows"]),1)

    def test_normal_cycle_saves_orders_and_refusal_without_false_open(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = m.Store(Path(tmp) / "checkpoint.sqlite3")
            try:
                clock=Clock()
                origin=round(clock.wall()*1000)
                source=FakeSource(clock, snapshots=[[],page(order("1",origin)),[],page(order("2",origin+6000)),[],m.Stop("http_429")])
                watcher=m.Monitor(store,source,lambda:None,clock=clock.monotonic,wall=clock.wall,
                                  sleep=clock.sleep,logger=lambda *a,**k:None,observe_orders=True)
                watcher.run(max_cycles=3)
                self.assertEqual(store.state["errorCode"],"http_429")
                self.assertEqual(store.state["orderSample"]["rows"]["BTCUSDT:2"]["created"],origin+6000)
                rows=[json.loads(row[0]) for row in store.db.execute("SELECT payload FROM events")]
                self.assertEqual([row["kind"] for row in rows],["new_public_order"])
                calls=len(source.calls)
                watcher.run(max_cycles=1)
                self.assertEqual(len(source.calls),calls)
            finally:
                store.close()

    def test_closed_target_creates_no_transport_or_database(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(m,'Transport') as transport:
            db=Path(tmp)/'test.sqlite3'
            self.assertEqual(m.main(['--once','--state-db',str(db)]),2)
            self.assertFalse(db.exists())
            transport.assert_not_called()
