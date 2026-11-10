# Public trader historical windows

The public leaderboard provides week, month, and allTime ROI/PnL. These remain source values. ALL is labeled 来源累计; it is not a sum of the other displayed periods or a guarantee of the account’s complete lifetime history.

The portfolio normalizer extracts 90D, 180D, and 365D from the real allTime PnL history. Each requested window ends at the latest source sample. It uses only actual samples at or after the requested start, without interpolation or substituting a monthly/cumulative return. The display includes the actual first/last sample and coverage. PnL is the selected last minus first value. Fewer than two samples leaves the derived metrics unavailable.

Long-window ROI remains null: sampled PnL and equity alone do not establish an exact cashflow-adjusted return. Every card keeps ROI as its headline; unavailable long-window ROI is shown as unavailable, and interval PnL in USD stays in the profit row. The legacy cached drawdown calculation rebases selected PnL and divides peak-to-current decline by positive account equity at that peak. This is a sampled PnL/equity ratio, not cash-flow-adjusted NAV maximum drawdown. The UI no longer displays or ranks public accounts by that ratio, including ratios below 100%; standard maximum drawdown remains unavailable until a verifiable NAV basis exists.

A read-only portfolio collector configured for scheduled execution saves normalized windows in trader/portfolios.json, with original sample ranges, collection timestamps, and last-good failure states. It uses a separate bounded request budget; the workflow separates the portfolio and fill workers by a full minute and carries HTTP 403/429 stop status forward. Raw fills, credentials, and trading operations are not involved.

The explicitly labeled recent perpetual closing-fill-fragment sample win rate remains visible when the selected portfolio period has no metrics. It continues to represent the latest available closing-fill sample, not the selected 90/180/365-day win rate. Its sample range and collection timestamp remain visible.

Official references:
- https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
- https://hyperliquid.gitbook.io/hyperliquid-docs/trading/portfolio-graphs
- https://hyperliquid.gitbook.io/hyperliquid-docs/trading/miscellaneous-ui

The sample win rate excludes spot and opening fills and is not a complete-order or round-trip metric. Details show source and eligible sample counts, exclusions, actual time range, whether the 2000-fill cap was reached, and the limits of the closing-fee-only calculation. See trader-metric-semantics-report.md for the screenshot audit.
