# US closing selection worker

Run `node server/us-daily.mjs` in the repository, or deploy these modules together under `/opt/books/app` and set:

```
BOOKS_SITE_DIR=/opt/books/site
BOOKS_US_SELECTION_DIR=/var/lib/books/us-selection
```

The worker uses the verified `market-calendar.js` US sessions and `America/New_York`, including DST, holidays and early closes. A 30-minute minimum guard prevents reading an immediate close, while the installed timer determines the actual first run (currently 17:15 America/New_York for a normal session). Source bar dates and full-batch checks still determine readiness. The current calendar verifies 2026 only; unsupported years stop with a visible error. The systemd timer/service installation is separate from this module.

## Sources and scope

- TickFlow free daily batch API; no credentials or paid package required.
- Its documented policy permits personal storage, backups, quantitative research and published derived statistics/charts. Raw quotes must not be repackaged as a third-party data API. Policy: https://docs.tickflow.org/zh-Hans/faq#数据使用授权 .
- Provider `type=stock` also includes ETFs. The worker excludes names explicitly identifying funds, ETFs/ETNs, trusts, warrants, preferreds, units, rights, depositary securities and acquisition vehicles. Unsupported symbol annotations are retained as exclusions rather than weakening the symbol format. The rest is a **provider-listed equity observation pool**, not a certified full ordinary-share universe.
- US daily timestamps are interpreted in `America/New_York`; volume is in provider-reported shares. A missing or zero `amount` never becomes a genuine zero-turnover exclusion: the close-times-volume proxy is explicitly labelled.
- Proportional forward adjustment is requested. The free source does not expose corporate-action factor details for individual reconciliation, so observations never claim independently verified adjustment events or a validated trading edge.
- Nasdaq web/API collection is not enabled. Merely being publicly readable is not permission for automated analysis.

Requests are serial, 50 symbols per daily batch, at least 3.5 seconds apart (less than 18/minute). The allowance is IP-wide and is shared with other jobs. HTTP 401/403/418/429/451 persists a source hold; future timer runs do not retry it. No alternate endpoints or proxy bypasses are used.

## Private storage and recovery

`sourceTime` is explicitly `scheduled_regular_close`, not the vendor's publication time. `providerPublishedAt` stays null because the provider does not supply it; `sourceBarTime` is the daily bar's midnight label, and `fetchedAt` is the actual local receipt time.

- `state.json`: current phase, processed/expected/covered counts, errors, last failure and last successful pointer.
- `published.json`: atomic pointer to a completed immutable batch. A partial or failed run never replaces it.
- `batches/<generation>/snapshot.json.gz`: complete private result. Includes chart OHLCV for the root server's derived SVG renderer; do not expose these raw arrays through the public API.
- `batches/<generation>/ledger.json.gz`: first-observation and prospective follow-up records.
- `batches/<generation>/universe.json.gz`: actual source directory, exclusions and scope.
- `raw/history/<encoded-symbol>.json.gz`: cumulative normalized source OHLCV. Old dates are retained, new dates appended and revisions replaced.
- `batches/<generation>/changes.jsonl.gz`: the new/revised bars for this batch, including the initial historical baseline. Apply these in generation order by symbol/date to restore every saved raw history; the previous completed snapshots and ledgers remain individually recoverable.

No data archive is automatically deleted. Incremental changes avoid copying the full 500-session pool every day. These are source OHLCV archives with normalized dates, not byte-for-byte HTTP traffic logs. A zero provider `amount` is treated as unavailable rather than genuine turnover.

The current pointer binds chart data to one completed batch. Reading a canonical history during a running collection is not evidence that its current row belongs to the published batch. `readPublished(directory)` loads and verifies the completed pointer; `readState(directory)` loads progress only.

## Meaning of B, S and tracking

U2/U3 thresholds remain unchanged. PULLBACK is a separate fixed draft branch, not a loosened U2 gate. `qualified` stays false until independent validation and missing eligibility evidence are supplied.

B is a mechanical closed-daily observation, never a fill. `signalDate`, `isNewB` and `phase` distinguish a new closed-day B from a prior B being followed. Prices are frozen on first observation. If the same daily candle can touch both trigger and invalidation, chronology is unknown and no executable fill is assumed. X/S are research invalidation/exit observations, not proof of a real order or best exit. No +/- intraday T signals are fabricated from daily bars.

Two independent series are retained: `followup` starts from the first observed closing price; `triggerFollowup` starts from the actual saved B-trigger day's closing price, even if B occurs several waiting days later. The page defaults to the B-trigger series. Untriggered conditions have status `not_triggered` and pending horizons. Legacy B records without a saved trigger close can only restore the corresponding real archived daily close, explicitly labelled as research; no touch price or fill is inferred. Returns are measured at 1/2/3/5/15 benchmark trading sessions. They are price returns, not execution P&L or dividend-adjusted total returns. Maximum adverse low relative to that reference and maximum close-to-close drawdown are separate. Missing sessions remain missing; exited/invalid conditions are retained in the statistics. An exited or expired waiting cohort cannot later generate a new B.

Verification: `node --test audit/us-selection-unit.mjs`.
