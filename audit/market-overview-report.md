# Market overview data cards

This report records the original five-card public-statistics snapshot, the macro collector correction and the November 13 one-time source refresh. Source collection, deployment and browser acceptance are separate verification steps.

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

## Macro collector correction (2026-11-13)

The original macro collector read only the Employment Situation feed. It could continue showing payroll news after a newer CPI or PPI release. The collector now merges the Employment Situation, Consumer Price Index and Producer Price Index news-release feeds listed in the [official BLS RSS index](https://www.bls.gov/feed/), together with the existing official release calendar. The main thread verified the official index's actual link targets as `/feed/empsit.rss`, `/feed/cpi.rss` and `/feed/ppi.rss`, without opening those feed links during that documentation check; the separate CPI latest-numbers feed is not used. This increases a fully due one-shot collection from six to eight fixed requests; it does not add a schedule or change minimum fetch intervals.

Releases are deduplicated by official release URL and publication time, with the latest source revision retained for a duplicate. The headline is chosen by `publishedAt`, not by the feed's HTTP modification time, a later revision to an older release, or the collection time. The exact source title and release URL remain in `data.latest.title` and `data.latest.url`. An HTTP 200 response with no new release keeps the original publication/update times. Valid empty feeds retain the previous release; without a previous release the card stays unavailable. Malformed feeds and source refusals still preserve the whole last-good card. Any BLS 403/429 immediately prevents later BLS feed/calendar requests and persists the existing host stop.

Slow source frequency remains separate from a broken refresh. For example, the [Treasury's 2026-10-16 TIC release](https://home.treasury.gov/news/press-releases/sb0662) publishes August 2026 data and gives November 18 as the next release date. Thus August is still the latest published TIC month on November 13. This module measures monthly foreign net purchases of US long-term securities; it cannot serve as intraday capital-flow monitoring. CSI valuation is also a month-end factsheet, and Fear & Greed is a daily reading. A more recent fetch must never turn these source dates into live market data.

The collector change passed 29 offline fixture tests, including multi-feed deduplication, real publication ordering, exact release-link preservation, unchanged/empty successful feeds, and BLS same-host refusal short-circuiting. The PDF parser contract fixture uses a mock module and needs no package download; a real CSI PDF collection still requires `pypdf==6.21.4`. Multi-feed success is tested offline; it was not verified against live feeds because the first real BLS request was refused, as recorded below.

## One-time source refresh (2026-11-13)

The main thread performed one reviewed manual collection from **14:31:31 to 14:31:49 UTC** (22:31:31–22:31:49 Beijing time). It made five requests: three HTTP 200 responses, one CSI `network_error`, and one BLS HTTP 403. There were no retries. The candidate output was generated at `2026-11-13T14:31:49Z`; it is a collection result, not evidence of deployment. This documentation update does not merge it into production or enable a background schedule.

| Card | Actual result | Source date/time kept in candidate | Collection outcome |
| --- | --- | --- | --- |
| Market temperature | HTTP 200; 20, Extreme Fear; previous day 28 | `2026-11-13T00:00:00Z` | Ready; fetched `14:31:33Z` |
| Core valuation | `network_error`; retained PE 12.61, PB 1.30 and dividend yield 2.73% | 2026-10-30 China time; original source modification `2026-11-03T08:41:20Z` | Stale; last successful fetch remains `2026-11-10T09:40:13Z`; attempted `2026-11-13T14:31:33Z` |
| Cross-border funds | HTTP 200; latest file row remains **2026-08**, USD 300,724 million in foreign net purchases of long-term securities | Period cutoff `2026-08-31T00:00:00Z`; file modification remains `2026-10-16T20:06:51Z` | Ready; fetched `2026-11-13T14:31:47Z`; successful refresh does not change the data month |
| Active assets volume snapshot | HTTP 200; source's returned top-10 sample, 191 listed assets including stablecoins; normalized display retains USDT/BTC/ETH | Individual ticker cutoff `2026-11-13T14:27:50Z` | Ready; fetched `14:31:48Z`; 24-hour volume is not intraday net flow |
| Macro releases | Employment feed HTTP 403; retained the previous November 6 employment release and old calendar | Publication remains `2026-11-06T12:50:31Z` | Stale; last successful fetch remains `2026-11-10T09:40:42Z`; attempted `2026-11-13T14:31:48Z` |

At `2026-11-13T14:31:49Z`, the candidate persisted `sourceStops["www.bls.gov"] = {"code": "http_403", "at": "2026-11-13T14:31:49Z"}`. **CPI, PPI and the calendar were not requested after that refusal.** Future collectors must retain this stop and make no requests to the stopped host; no client, mirror, proxy or alternate BLS page may be used to bypass it. The CSI network error did not create a 403/429 stop, and this run did not retry it. Macro freshness and real multi-feed parsing therefore remain unverified; the new collector logic must not be reported as a successful live macro update.

The public [refresh receipt](market-overview-refresh-receipt.json) contains only allowlisted request metadata, URLs, response lengths/hashes, safe error codes, card timestamps/status and the candidate output hash. Original response bodies remain outside the repository in the local review directory. The receipt binds this manual source-refresh result; deployment and browser acceptance are separate steps.

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

The original November 10 version passed 25 collector tests and 18 UI/DOM checks. The November 13 collector correction passed 29 offline collector tests. Fixtures are synthetic and never copied into production data. Coverage includes PDF named cells in a two-column layout, TIC units/totals, ticker per-item time, BLS Atom/ICS and DST, input bounds, persisted source refusals, no retries, response size limits, atomic save, last-good preservation, stale rendering, safe links, same-origin deduplication and responsive breakpoints. The original 4,258-byte normalized snapshot passed both Python and browser validators; SHA-256 `6b8cc9cbcd4b50e848ca3809becc90770095e971b2c2f6ee068b49ab0563b0e3`. The separate November 13 candidate hash is recorded in the refresh receipt and does not replace those original-snapshot facts.

Publication uses the existing `[ui-only]` path. It must skip all Hyperliquid and Binance source steps, keep the committed snapshot dates and run existing deployment checks. Browser visual verification and deployment outcome are reported separately after publication; offline DOM tests are not real-device acceptance.
