# Viprasol indicator ports

Source: https://github.com/Viprasol-Tech/tradingview-indicators
Pinned commit: `a16096c1f2ba5ba5d4b8df97ff60ce8b4ce084d0`.
All 29 published `indicator()` files and their MPL-2.0 license are retained in `viprasol-source/`. There are no upstream `strategy()` declarations. Native JavaScript ports retain source attribution and expose computational inputs; colors and TradingView-specific drawing controls use the Books theme.

`viprasol-registry.mjs` dispatches every indicator. Four flat modules hold the separate original formulas. `viprasol-math.mjs` supplies closed-bar arithmetic. The page reads the existing same-origin `data/latest.json`, with original capture/completion times; it does not change the collector, trading engine, A-share screening or financial records.

Dependencies are explicit. Missing minute bars, macro series, benchmarks, tick size or session metadata stop the relevant calculation. No synthetic prices or same-period substitutes fill missing sources. A session volume profile requires lower-timeframe bars; daily bars cannot reconstruct a daily intraday profile. Optional filters only remove dependencies when explicitly disabled by their original parameters.

Signals remain research events, not fills. Confirmed pivots are emitted on their confirmation bar, not their origin bar. Structure, statistical alerts and personal goals are not B/S entries. The retained upstream caveats include Market OS initialization, Elite Flow last-bar zone cleanup, the scanner expiry branch, unused APEX `slMult`, reversed bearish Fib gap and MTF display-mode semantics. Same-bar target/stop counters are source reference counters, not trading performance.

Tests cover formula branches, long/short fixtures, missing/invalid series, confirmation times, parameter bounds, immutable inputs and causal prefixes. Browser checks cover all 29 selections, current data provenance, parameter/window changes, explicit disabled states and preservation after a failed or older refresh. TradingView native per-bar numerical parity and profitability have not been established.
