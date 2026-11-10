# Long-period public-ledger ROI

The homepage and plaza previously hard-coded 90/180/365-day ROI to null at generation, validation and display. This change adds a separate, evidence-checked calculation for actual perpetual-account sample intervals. Native week/month/all-time leaderboard returns remain unchanged.

## Definition and limitations

The calculation is `100 * period PnL / max(100, initial account equity + maximum cumulative net deposits)`. It follows the capital-base formula described by the Hyperliquid leaderboard, but is computed here from queried public data. It is not a source-published custom-period ROI, a time-weighted return, or a guarantee of complete account history.

The actual first and last paired equity/PnL samples define the calculation interval. No boundary interpolation, lifetime-ROI substitution, or sparse-sample estimate of the maximum capital base is used. A requested year may cover fewer than 365 days because the source samples are sparse; the actual range stays visible.

Public non-funding ledger events are traversed with an inclusive overlapping timestamp cursor, deduplicated and bounded. Unknown event semantics, unsupported currencies/scopes, saturated boundaries, collection truncation, failed requests or any unreconciled interval produce no new return. Every adjacent equity/PnL interval must reconcile with identified capital flows within 0.02 USD absolute error. A zero-net deposit/withdrawal round trip still contributes its intrainterval capital peak when present in the returned ledger.

The API does not publish a guaranteed one-year retention horizon. Finishing a query and reconciling net flows cannot prove that an unreturned zero-net round trip never happened. Therefore evidence records query exhaustion and `historyComplete:false`, and the UI labels results as self-calculated public-ledger returns rather than exact full-history returns.

## Source checks performed before implementation

On 2026-11-10, anonymous read-only probes of existing public ranking addresses returned portfolio and ledger data successfully; no authentication, proxy, bypass, trading action or source retry was used.

- `0x5b5d51…98c060`: 92 lifetime paired samples and 312 returned ledger events in the requested annual sample range. Withdrawal fees mattered for reconciliation. After accounting for them, 27 sample intervals still had material discrepancies. Those data do not justify a return for this account.
- `0xb83de0…7d6e36`: 325 initial ledger events, including a rewards event whose capital semantics must not be guessed.
- `0xecb63c…b82b00`: the first ledger page contained 2,000 events and stopped months before the requested end. A single successful request would be insufficient; pagination is required.

These are diagnostics, not published returns. Raw ledger responses are not added to this repository.

## References

- https://app.hyperliquid.xyz/leaderboard
- https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
- https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals
- https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits
- https://hyperliquid.gitbook.io/hyperliquid-docs/trading/portfolio-graphs
- https://hyperliquid.gitbook.io/hyperliquid-docs/trading/account-abstraction-modes
- https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint#send-asset

The current official leaderboard locale asset `https://app.hyperliquid.xyz/assets/en-US-1gJt-J76.js`, key `leaderboard.formula.explanation`, supplies the capital formula; `Leaderboard-D06I9MTf.js` renders that key. The Send Asset contract identifies `""` as the default USDC perpetual DEX and `"spot"` as spot. Explicit spot-to-spot transfers therefore do not create default-perp capital flows merely because they carry a spot/native fee. The actual perpetual equity/PnL samples must still reconcile; this does not claim that spot has no economic effect in unified-account modes.

Vault deposit/withdrawal/distribution remain unsupported: official transfer-display code changes sign for vault accounts and may synthesize a commission display row. Those presentation rules do not establish the correct capital flow in `perpAllTime`; no artificial fee row or guessed vault principal is inserted.

## Validation and rollout

Local integration was rebased onto the avatar/card changes and the succeeding real position snapshot at `ae5e769`. No current Binance source or display changes were overwritten.

All 34 Node commands from the deployment workflow passed against that integrated version. Relevant suites: period mathematics 24, portfolio collector 56, homepage data 30, homepage UI 19, plaza 241, persistent refusal guard 13 and final-position guard 20. The separate Python Hyperliquid collector suite passed 29 tests; its first read-only-sandbox attempt could not create temporary directories, so it was rerun with local temporary-file access. Tests use synthetic fixtures; no fixture is published as a trader result.

Review found and fixed two evidence boundaries (same-millisecond capital events at a sample boundary and zero-event invented capital) and a collection starvation issue. Unavailable-account attempt metadata now survives validation, and the queue rotates by actual success/attempt times. Two bounded offline batches reach accounts 1–4 then 5–8. Ordinary ledger failure can retain the verified base portfolio with its original response time; a previous proven ROI retains its entire old portfolio. Source 403/429 still stops the batch without publishing a new fallback.

The seven-minute budget cannot refresh all 135–200 long-window ledgers in one run. Native portfolio and ledger requests share the unchanged 600-weight/minute, concurrency-two budget; remaining accounts rotate in later existing full runs. No schedule, TTL, credentials or permissions were changed.

A first live validation was cancelled when another positions-only publication appeared. It did not replace the committed portfolio snapshot. The subsequent run began after that publication completed, all in-progress/queued/waiting workflows were absent, and all persisted source guards allowed collection. Its actual coverage and publication result will be recorded after completion.

The first completed live batch (11:38:52–11:45:52 UTC) made 43 requests, including 28 ledger requests: 15 accounts attempted, 13 completed, two reached the batch deadline, and 120 were unattempted. It produced no publishable ROI. This exposed explicit spot-to-spot fees being rejected before checking the perpetual scope, which was corrected without changing the reconciliation tolerance. Vault events remain unsupported. The first diagnostic snapshot is retained separately in the cloud workspace and is not the release snapshot.

A second correction reads the quarter first, then only the additional earlier half-year/year segments, sharing one ten-page/20,000-row budget. A failed annual extension no longer erases a verified quarterly return. Tests cover segment boundaries, global page/row limits, partial proof timestamps, prior-good records and 403/429 after a short-window success.

## Final bounded live verification

The corrected collector ran 2026-11-10 11:53:12.212–12:00:12.223 UTC, using the latest committed last-good cache as its baseline and keeping the earlier diagnostic separately. It made 38 requests (31 ledger requests), all observed HTTP responses were 200. Seven accounts were attempted: five completed their bounded queries, two reached the batch deadline; 128 were unattempted. All 135 last-good/base portfolio records remained available. No 403/429 occurred. The final file passed both collector and homepage validators and remained below the homepage's 4 MiB limit.

**No numeric long-period ROI passed in this live batch.** This is not a successful numeric rollout for the screenshot accounts. The leading account's quarter/half-year intervals failed cash-flow reconciliation; its annual ledger contains unsupported events. Other attempted records likewise failed reconciliation, contain unsupported ledger events, lack sufficient history, or await another bounded segment. The public snapshot keeps null with the precise reason. Synthetic passing tests are not evidence of successful real-account returns.

The change implements and validates the automatic conditional calculation path, persistent proof, pagination, fairness and honest UI states. It does not solve missing or inconsistent source accounting, produce an exact TWR, guarantee historical retention, or guarantee that every listed trader can obtain a long-period percentage. Existing native week/month/lifetime source returns are unaffected.
