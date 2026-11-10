# Homepage trader ranking

Replaces the unused homepage trading leaderboard with three rolling-window tabs: monthly (source month / 30D), quarterly (90D), and yearly (365D). All tabs rank positive period PnL in USD and show at most three accounts, with stable ID ordering for ties. This is a monetary-performance shortlist of the site's collected Hyperliquid candidates, not a full-market ranking or composite trader-quality score. Binance profiles without comparable period metrics are excluded.

## Data and scope

The browser reads only the same-origin `trader/feed.json`, `trader/portfolios.json`, and `trader/analytics.json` already consumed by the plaza. No additional provider requests, keys, collection workflow, or source-time modification is introduced. Visibility-aware 60-second revalidation reads those static files; switching tabs does not refetch them.

- Monthly PnL and ROI come from the source leaderboard's monthly window.
- Quarterly/yearly PnL uses the corresponding perpetual-account history window. `insufficient_history`, missing values, zero/negative PnL and unverified records are excluded. Source sampling boundaries and actual coverage remain visible. Long-period ROI remains unavailable because the existing source lacks a verified cash-flow-adjusted capital basis.
- Drawdown retains the plaza's sampled-PnL ratio and its own sample/collection times. It is not standard NAV maximum drawdown and can exceed 100%. Its age is assessed from both collection and sample-end time.
- Win rate refers to recent closing-fill fragments, independent of the selected period. Fewer than 20 eligible fragments remain unavailable. Metadata preserves the sample range, count and closing-fee-only calculation, excluding opening fees and funding.
- Historic records remain available when stale; current holding eligibility still expires at 60 minutes. Read failures retain last-good values and mark affected data independently. Candidate selection is the site's monthly PnL top-200 source pool, not the entire exchange.

On baseline `dd7541541993b91e235a9051f4cf0847233a7d8a`, eligible positive-PnL counts were 135 / 66 / 59 for 30D / 90D / 365D. Monthly source cutoff was 2026-11-10 09:26:50 UTC; portfolios and analytics remained around 01:00–01:24 UTC and are correctly labelled old. These are validation observations, not newly collected figures.

## Interaction and safety

Trader links carry an allowlisted `account` address and selected period into the plaza. The plaza opens only an account found in its already-validated public records, then clears the pending action. Background refresh cannot repeatedly reopen the dialog; unknown addresses or local/private records cannot be introduced through the URL. The link opens the existing analysis view, not a live trading subscription.

Each input file is independently bounded (2 / 4 / 2 MiB), validated, fetched with a timeout, and protected from timestamp rollback. Names render through text nodes; account URLs derive solely from validated addresses. The three buttons expose their selected state and keyboard focus survives refresh.

## Validation

```sh
node audit/home-trader-data-unit.cjs
node audit/home-ranking-ui-unit.cjs
node audit/trader-unit.cjs
```

23 data checks, 17 UI/DOM checks, and 223 plaza checks pass. Tests include the actual committed snapshot projections and independent Top 3 comparison, missing/old/corrupt inputs, old sample with a fresh download, scope/period mismatch, bounded reads, deduplication, safe links, focus preservation, and one-time deep linking. Synthetic fixtures remain in test files only.

Before publication, the patch was integrated with main `1d9b30638a93d33c304b6cf511e1d4530f2966ff`, preserving the newly added Binance reference identity and collapsed source disclosures. The integrated plaza suite (223 checks) and Binance adapter suite (26 checks) passed; the source snapshots were unchanged.

The existing deployment test step now includes the two homepage suites. No trigger, schedule, permissions, provider step or refresh mode was changed. Publish with `[ui-only]`, preserving all committed trader snapshots and skipping source collection. Browser visual and public-file verification are performed separately after deployment.
