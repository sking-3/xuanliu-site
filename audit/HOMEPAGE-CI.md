# Homepage CI source boundary

`verify-home-dashboard.yml` is independently triggered by selected files on a main push, including `index.html`, or by manual dispatch. Previously its Chromium job unconditionally ran `home-provider-browser.cjs`, which loaded the homepage on Pages or a loopback server and required real provider quotes. A local homepage URL did not isolate its nested requests.

That live step has been removed for every event, rather than only for one commit label. The old CLI now fails explicitly without importing Playwright or starting a browser. Its former implementation is retained in Git history. The detailed homepage tests remain: committed dated rankings, simulated quote widgets, compact/full quote layouts, independent outages/recovery, macro rendering, navigation and trader deep links on desktop and phone viewports.

| Request family reachable from the former live probe | New automatic gate behavior |
| --- | --- |
| TradingView embedding scripts, ticker tags, quote/datafeed frames and symbol images | Known scripts use synthetic fixtures; all other external HTTP is blocked. |
| Third-party `wenyuanw/a-share-heatmap` raw GitHub snapshot | Blocked; the test checks the committed dated rank archive. |
| Tencent `web.ifzq.gtimg.cn` and its configured `proxy.finance.qq.com/ifzqgtimg` alternative in the index strip | Both blocked; no same-source alias is tried by the test network layer. |
| Bitget spot ticker REST and public WebSocket | REST and the exact socket are synthetic. The socket never connects to the provider. All other sockets close locally. |
| External source links such as BLS, Eastmoney and Nasdaq Trader | Link destinations are inspected as text; external links are not fetched. Local link checks use `maxRedirects: 0`. |

Source-stop records are scoped to their actual source and endpoint. For example, the recorded private Bitget candle refusal does not prove that a previously readable public spot endpoint is refused; it also does not authorize probing either one in CI. The automatic gate avoids this ambiguity by making no real provider calls. Recorded BLS/Yahoo refusals and Tencent read failures must not be cleared or retried to make a release pass. These tests do not certify current quote availability, market-wide price accuracy, or the legal/data entitlement status of a provider.

The loopback destination is validated before Playwright loads. Service workers are blocked, all WebSocket URLs are intercepted, and HTTP routes continue only to that local origin. No environment variable enables the retired live probe. The policy tests cover rejected external destinations, cross-origin link requests, the retired CLI and workflow trigger behavior.

The complete release still has a separate collection workflow: `refresh-traders.yml`. The final UI-only merge commit must contain `[ui-only]`, and the existing event/checkout SHA resolver must select `skip`; missing the marker can select live collection. Its schedules, manual scopes and persisted source guards are unchanged. The homepage fix does not claim that every unrelated scheduled task is offline. New real-provider checks require their own bounded source policy and a review of applicable persistent stops; they must not be reintroduced as an unconditional homepage release gate.
