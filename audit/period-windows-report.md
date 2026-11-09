# Public trader historical windows

The public leaderboard provides week, month, and allTime ROI/PnL. These remain source values. ALL is labeled 来源累计; it is not a sum of the other displayed periods or a guarantee of the account’s complete lifetime history.

The portfolio normalizer extracts 90D, 180D, and 365D from the real allTime PnL history. Each requested window ends at the latest source sample. It uses only actual samples at or after the requested start, without interpolation or substituting a monthly/cumulative return. The display includes the actual first/last sample and coverage. PnL is the selected last minus first value. Fewer than two samples leaves the derived metrics unavailable.

Long-window ROI remains null: sampled PnL and equity alone do not establish an exact cashflow-adjusted return. Cards show interval PnL in USD instead of inventing a percentage. Derived drawdown rebases the selected PnL history and divides each peak-to-current decline by positive account equity at that peak, using exact timestamp pairs. This is a sampled PnL/equity metric, not strategy NAV drawdown or a guarantee of intraday maximum loss.

A scheduled read-only portfolio collector saves normalized windows in trader/portfolios.json, with original sample ranges, collection timestamps, and last-good failure states. It uses a separate bounded request budget; the workflow separates the portfolio and fill workers by a full minute and carries HTTP 403/429 stop status forward. Raw fills, credentials, and trading operations are not involved.

The independent closing-fill sample win rate remains visible when the selected portfolio period has no metrics. It continues to represent the latest available closing-fill sample, not the selected 90/180/365-day win rate. Its sample range and collection timestamp remain visible.

Official references:
- https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
- https://hyperliquid.gitbook.io/hyperliquid-docs/trading/portfolio-graphs
- https://hyperliquid.gitbook.io/hyperliquid-docs/trading/miscellaneous-ui
