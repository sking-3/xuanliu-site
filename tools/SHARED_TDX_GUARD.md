# Shared TDX guard draft

This patch does not enable data collection. PRODUCTION_GUARD has no state adapter
and incomplete migration; the new feed's independent hard closure also remains.
No existing stop file, source-holds policy, browser record or database is modified.
No reset or expiry-based recovery is provided.

tools/tdx_source_guard.py uses the fixed upstream identity tdx.marketdata.cn for
tdx/mootdx/pytdx/tdxpy. Tencent, Sina, Eastmoney, Tushare and the site's published
JSON are not aliases. Missing state, unknown aliases, incomplete migration,
malformed records, CAS conflicts and storage errors prevent requests.

The external adapter contract requires authoritative, strongly consistent reads
and atomic compare-and-swap by revision. Records are never initialized implicitly.
Each factory/request reserves pending before invocation. Denial/interruption
records stopped; failed stop writes retain the already-persisted pending record.
A new runner cannot reclaim pending by time. Nested SDK calls recheck the same
reservation. An independent stop/revocation is never replaced with ready.

The old TDX import, factory and data methods now consult the same guard as the new
collector. Old refusal errors cannot be swallowed by fallback or per-stock loops.
The legacy mootdx factory still has its historical automatic bootstrap options;
it is unreachable under the production closure. Before any future enablement,
replace that legacy transport with the audited fixed-server implementation.
The guard is not permission to enable old SDK bootstrap or scan servers.

The public browser's books.stock.published-source-stop.v1 protects the site's
research-data/snapshot.json, not TDX. The private worker source_stops table uses
research:Tushare etc. No actual legacy TDX stop event has been located in the
accessible repository. That inventory is incomplete, not a clean-source finding.
No fabricated migration-complete production record is included.

SQLiteFixture in tools/test_tdx_source_guard.py is synthetic test infrastructure,
not the production persistence adapter. Tests use separate Guard/store instances
and a subprocess sharing one temporary SQLite file; SDK connections are mocked.
Existing parser/local-filesystem cases explicitly bypass the new guard, while
the new integration tests exercise the real guard against fake transports.

Run:
python -B -m unittest tools.test_tdx_source_guard tools.stock_research.test_a_share_sources -v
python -B -m unittest tools.mootdx_feed.test_collector -v

The independent verify-shared-tdx-guard workflow runs these offline tests on Python
3.11/3.12 and installs only the existing hash-locked parser dependency set. It has
no workflow_dispatch, schedule, deployment or collector invocation. No live-source
availability or cross-runner production-store acceptance is claimed.
