# Market overview data cards

This change replaces the five empty research counters on the homepage with public statistics. It preserves the ticker, market widgets, navigation and trader snapshots.

## First real snapshot

Collected once on 2026-11-10 at 09:40:02–09:40:42 UTC. Six successful public HTTP responses; no retries, credentials, proxies or trading API calls. The normalized snapshot is `market-overview.json`. Original bodies stay outside the repository. A PDF parser correction re-used the saved response and retained its original collection time.

| Card | Source and scope | Actual source date | Verified facts |
| --- | --- | --- | --- |
| Market temperature | [Alternative.me](https://alternative.me/crypto/fear-and-greed-index/), Bitcoin Fear & Greed | 2026-11-10 | 32, Fear; previous day 29 |
| Core valuation | [CSI 300 factsheet](https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/indices/detail/files/zh_CN/000300factsheet.pdf), month-end | 2026-10-30, China time | PE(TTM) 12.61; PB 1.30; dividend yield 2.73% |
| Cross-border funds | [US Treasury TIC](https://home.treasury.gov/data/treasury-international-capital-tic-system-home-page/tic-forms-instructions/securities-a-us-transactions-with-foreign-residents-in-long-term-securities), foreign net purchases of US long-term securities | 2026-08; source file modified 2026-10-16 | USD 300,724 million = 3,007.24 亿美元 |
| Active assets | [Alternative.me](https://alternative.me/crypto/), returned top-10 volume sample including stablecoins | 2026-11-10 09:37:56 UTC, individual ticker timestamps | USDT, BTC, ETH; raw USD 24-hour volumes retained |
| Macro releases | [BLS employment release](https://www.bls.gov/news.release/archives/empsit_11062026.htm) and [release calendar](https://www.bls.gov/schedule/news_release/) | Employment release 2026-11-06 | October payroll +165,000, unemployment 4.1%; future CPI/PPI/employment events |

These are distinct market scopes. Bitcoin sentiment is not A-share breadth. Valuation is not live or a historical percentile. TIC is monthly US securities flow, not Chinese daily main-fund flow or total TIC flow. Volume is not net inflow or hot-search popularity. The macro card uses factual official releases, not generated research or an asserted explanation for price moves. Alternative.me attribution is visible next to its data.

## Collection and freshness

`scripts/collect_market_overview.py` is a one-shot collector. No new scheduled workflow is included or enabled in this change. The browser re-reads the same-origin JSON every 10 minutes while visible; this does not collect new source data. Existing trader workflows do not update these five cards.

After installation of `scripts/requirements-market-overview.txt`, an authorized one-time refresh can run:

```sh
python3 -B scripts/collect_market_overview.py --output market-overview.json
```

Source dates, source publication/modification dates, last attempts and collection times remain separate. The collector preserves last-good values on failure and persists HTTP 403/429 stops by host; stopped hosts are not automatically retried. A malformed previous snapshot fails before fetching. A successful later publication must preserve these stops.

Ready cards are reused within minimum fetch intervals (6 hours for sentiment/macro, 24 hours for valuation/TIC, 45 minutes for activity); these intervals do not schedule execution. UI source-age limits are 3 days / 45 days / 120 days / 2 hours / 45 days respectively. Old values remain visible with their original cutoff and a stale label. Unavailable values stay empty. Future calendar events are shown in Beijing time and disappear after their start time.

## Validation

```sh
python3 -B audit/market-overview-collector-test.py
node audit/market-overview-ui-unit.cjs
```

25 collector tests and 18 UI/DOM checks passed. Fixtures are synthetic and never copied into production data. Coverage includes PDF named cells in a two-column layout, TIC units/totals, ticker per-item time, BLS Atom/ICS and DST, input bounds, persisted source refusals, no retries, response size limits, atomic save, last-good preservation, stale rendering, safe links, same-origin deduplication and responsive breakpoints. The actual 4,258-byte normalized snapshot passed both Python and browser validators; SHA-256 `6b8cc9cbcd4b50e848ca3809becc90770095e971b2c2f6ee068b49ab0563b0e3`.

Publication uses the existing `[ui-only]` path. It must skip all Hyperliquid and Binance source steps, keep the committed snapshot dates and run existing deployment checks. Browser visual verification and deployment outcome are reported separately after publication; offline DOM tests are not real-device acceptance.
