# Public account data integration verification

## Implemented scope

The trader page now consumes a real Hyperliquid public-account snapshot. The initial captured source contains 48,229 unique addresses. The normalized public file selects the 200 highest source month-PnL accounts, retaining source ROI/PnL for week/month/allTime and account value in USD. The selection is explicit; this is not a complete certified copy-trader list. Display names are user-provided and addresses are not verified real-world identities.

No fictional persons or example performance are published. No import/export controls were restored. Shared navigation, market ticker, other pages and private backend access remain outside this change.

## Data and failure semantics

- ROI conversion uses source ratio times 100; PnL and account value are source figures, including zero.
- MDD, wins, closed-trade count, curves and positions remain null/empty rather than derived from inadequate inputs.
- HTTP Last-Modified is the source file timestamp. Fetched time is recorded separately.
- The collector uses one bounded read-only request and validates JSON, windows, addresses, finite numbers and cache integrity.
- Failures preserve the validated last-good feed, with stale metadata. The frontend independently enforces a 120-minute age threshold and checks for new files once per visible minute.
- The scheduled workflow collects every 30 minutes, commits only the snapshot and explicitly deploys a full Pages artifact. Normal push and head checks prevent overwriting concurrent edits. Scheduling is best effort.

## Validation

18 collector tests cover real numeric conversions, zero/negative values, malformed/empty JSON, HTML with HTTP 200, duplicate accounts/windows, invalid numbers, timestamps, cache validation, atomic saving, and no retry for 403/429.

The DOM-model and static checks additionally validate the real selected accounts against the captured original response, source units, source period labels, freshness and existing local record behaviors. Their exact results are saved in the adjacent test-result files. No test fixtures are written to production data.

`hyperliquid-source-evidence.json` records the bounded read-only probe and official source-code references. The large raw source remains outside the repository. Final GitHub Actions execution and live cloud-browser validation are checked separately after publication; unit tests do not substitute for browser verification.
