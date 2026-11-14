# Public US intraday workspace — 2026-11-14

The public `us.html` links to `us-live.html`. No private-site deployment is required. No workflow, schedule, exchange order endpoint or shared account credential is introduced.

## Data path

- Each visitor supplies their own Alpaca Paper Key/Secret in the isolated page. Credentials exist only in a closure in page memory. The form is cleared immediately; disconnect and page exit abort requests and release credentials/results. No third-party scripts, frames, analytics or external fonts execute on that page.
- Fixed official GET requests use `credentials: omit`, `redirect: error`, IEX only, bounded response sizes and a shared request budget. `/api/research/*` are in-memory controller paths, not server routes or uploads. No account/order API is called.
- The browser polls snapshots at five seconds, official clock at thirty seconds and completed regular-session minutes at sixty seconds. A poll does not imply a new trade. Source trade timestamps, missing samples and stale trades remain explicit. IEX is one exchange, not consolidated US market data.
- The radar compares turnover at the same Eastern minute, same provider/feed and same regular-session scope against 10–20 prior trading days. Incomplete/future bars, short baselines and unsupported sessions cannot produce confirmed anomalies. Historical review retains historical source times and is visibly labelled.
- Page hiding cancels requests/timers and requires explicit restart. Inspectable HTTP 403/429 persist a source stop; CORS/network errors stop the current run without inferring an unavailable HTTP status. No proxy or alternative host is attempted.
- NVIDIA's official RSS is read without a key. Only financial title/date/link and attribution are displayed; currently coverage is NVDA only. A schedule is not actual earnings. Other companies' calendars are available through an official provider link; there is no claim of a verified all-market event API.

## Verification performed

- Public bridge, model, issuer-feed and standalone controller integration tests use synthetic credentials/data. They cover disconnect races, hidden/page-exit cancellation, provider/feed isolation, same-minute baselines, early close/DST, inclusive API end boundaries, result persistence in RAM and source stops.
- A local browser actually loaded the NVIDIA RSS and rendered its financial-results conference-call schedule with original publication date and real first-observed/receipt times. The no-credential path displayed a stopped state instead of invented quotes.
- Desktop and 390 px mobile checks verified the new page; tables scroll inside their containers rather than widening the document.
- Alpaca cross-origin OPTIONS preflight was verified for GitHub Pages. No actual user Key/Secret was available, so an authenticated GET, live quote update, historical retrieval and live radar acceptance remain pending on the user's own account. Passing synthetic tests is not equivalent to that acceptance.

## Source documentation

- [Alpaca market data scope](https://docs.alpaca.markets/us/docs/about-market-data-api)
- [Alpaca Paper Trading](https://docs.alpaca.markets/us/docs/paper-trading)
- [Alpaca historical bars and inclusive end](https://docs.alpaca.markets/us/reference/stockbars)
- [NVIDIA official RSS index](https://investor.nvidia.com/investor-resources/rss/default.aspx)
- [NVIDIA RSS terms](https://www.nvidia.com/en-us/about-nvidia/rss/)
- [Market Chameleon official earnings calendar](https://marketchameleon.com/Calendar/Earnings)

Personal market-data entitlement is not a public redistribution license. Keys, owner quotes, account data and raw provider payloads are not published to this repository. No new background schedule is enabled; live trading remains untouched.
