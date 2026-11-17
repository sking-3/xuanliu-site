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
The legacy path now reuses collector.fixed_server_factory instead of Quotes.factory.
BOOKS_TDX_SERVER must explicitly specify one IPv4:port; there is no default,
hostname resolution, candidate list or environment-driven fallback. Missing or
invalid configuration refuses before SDK import even if a simulated guard is ready.
Both paths bypass StdQuotes/BaseQuotes constructors, disable heartbeat/retry, connect
once to that endpoint and reject reconnect. The default production guard remains
closed; setting the environment variable does not enable collection.

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

## Independent authority protocol (implemented offline, not deployed)

A fresh runner cannot distinguish a valid old GitHub ready file from current
state using only that file, a signature, or a process-local watermark. Therefore
GitHubContentsStore is now explicitly non-authorizing; Guard rejects it before
any GitHub or source request. It remains an optional audit-mirror utility.
No production mirroring is configured. No mirror failure or old ready record
can grant source access.

tools/tdx_authority_state.py defines AuthorityStore. Its required trust root is a
separately administered, authenticated authority with linearizable reads and
atomic conditional transitions. The authority owns the complete guard record;
GitHub is not a second writer to the authorization state. Construction is inert.
There is no default transport, endpoint, credential, create, reset or resume API.

Each adapter is pinned to authority_id, a non-reusable stream_id and a SHA-256
migration-evidence digest. A missing/unknown stream or mismatched binding refuses.
The migration digest binds an already-reviewed inventory; it does not prove that
an inventory is complete or grant data rights. Production has no such attestation.

Each request uses a fresh challenge and a digest binding the complete request.
Replies must echo the binding, operation, challenge and request digest, and have
a valid full snapshot. This rejects replayed replies from another request.
It is not a substitute for transport authentication or the authority's durable
non-rollback guarantee; a dishonest or rolled-back authority can still lie.

The runner may only CAS ready to pending, or its current pending revision to
ready/stopped. Revisions increase by exactly one. Tokens never expire. Every
source callback follows a confirmed pending write and a fresh check. False
results, exceptions and interruption cannot complete to ready. A failed stop
write leaves pending. A lost reservation response invokes no callback; a new
runner observes pending. A conflicting/invalid/uncertain reply latches that client
closed without retry. Old tokens cannot overwrite an operator pause or controlled
resume, because the authority revision has advanced.

Operator pause uses stopped with an explicit reason. Resume is outside runner
permissions; any reviewed administrative recovery must advance the same durable
stream revision. Stream deletion/recreation, backup rollback, or revision reset
under the same identity must be impossible for runner credentials and detectable
by an independent durable control. A normal SQLite database, another GitHub file,
branch protection alone, or signatures on historical snapshots do not establish
this property. No such production infrastructure is provisioned or verified.

A pause prevents subsequently granted reservations. It cannot revoke packets
already sent, nor make the client check and TCP send atomic. Hard prevention of
new bytes after pause requires an authority-controlled execution/egress gate.
The client protocol does not claim that stronger guarantee. A lost completion
reply closes that client; if the authority actually completed the request, another
runner may observe the newer ready. No automatic quarantine is falsely inferred
from a client's inability to receive that reply.

## Offline evidence and scope

tools/test_tdx_authority_state.py models the authority with temporary SQLite.
It covers old GitHub ready restoration, a fresh adapter and separate process,
concurrent reservations, read/CAS races, lost reservation replies, stop-write
failure, False/interruption, operator pause/resume, wrong migration/stream identity,
replayed replies and malformed/exhausted revisions. All network connects are
blocked; all authority records are synthetic. SQLite here tests protocol and
process consistency, not infrastructure anti-rollback guarantees.

The existing GitHub adapter tests still verify strict Contents API paths,
generation/ABA within CAS, refusal handling and response validation. A regression
explicitly demonstrates that a fresh mirror reader accepts a restored old file
and that Guard refuses to use that reader as an authority. This is intentional
evidence of the trust boundary, not a claim that GitHub alone detects restoration.

Run:
python -B -m unittest tools.test_tdx_authority_state tools.test_tdx_github_state -v

## Remaining production decisions and evidence

- Legacy inventory: scripts/source-holds.json has no TDX approval; its other
  source/API stops are unrelated and unchanged. No actual legacy TDX stop event
  has been located in accessible repository data. The new local
  ~/.local/state/books/mootdx-feed/source-state.json has not been inspected on
  the user's machine. Unknown is not clean. Migration must reconcile all old
  TDX identities and unresolved pending/stopped evidence before any ready grant.
- Published-site browser stops protect owned JSON, not TDX; the private worker's
  source_stops records concern Tushare. Neither can be copied as TDX clearance.
  Tencent aliases also remain separate; this PR does not reset their history.
- Cross-runner: synthetic shared-state/process tests pass only after CI confirms
  the exact commit. Production needs independently authenticated runner clients,
  a non-reusable authority identity, monotonic retention/restore guarantees, and
  tests of two actual runners plus outage/recovery. No infrastructure is deployed.
- Display scope: the user's personal-use intent is recorded. The existing
  GitHub Pages website remains publicly reachable; it has not been made private.
  Repository software licensing and a personal-use statement do not constitute
  evidence of permission to redistribute provider data. No new terms search or
  license determination is performed in this patch. No verified public-data grant
  is recorded here. Choose and document a permitted source/display scope before
  a real producer publishes data; do not mark migration complete to bypass this.
- Daily five-session turnover output still needs real cloud availability,
  complete trading-day coverage, producer validation, and the publication/
  withdrawal protocol verified before release. The empty production list and
  both source closures remain in place. This draft must not be represented as
  completed live collection or cross-day production acceptance.
