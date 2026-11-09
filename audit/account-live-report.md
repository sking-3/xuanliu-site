# On-demand account activity review

## Scope and evidence

The new panel reads one selected public Hyperliquid account. REST initializes first-perpetual-DEX positions, default-DEX/spot open orders, and recent fills. WebSocket subscribes only to that account's `userFills` and `orderUpdates`. Closing the dialog, switching the account or leaving the activity tab releases the client. Hidden pages close the socket and pause reads.

The root's bounded live probes returned 23 positions, a valid empty open-order array, and 2,000 recent fills. An independent local normalization pass accepted all records without replacing source metrics. The captured WebSocket initial snapshot contained 30 fills; all 30 matched REST fill keys and can be deduplicated. This proves snapshot delivery and subscription acknowledgment, not observation of a new fill during the short probe.

## Review findings addressed

- A maps to sell and B to buy; source `dir` distinguishes opening, closing, reversals and spot buys/sells.
- Individual fills are retained; neither a short quiet interval nor a partial fill is treated as order completion.
- Source IDs, timestamps and finite numbers are validated. Fees retain their token and negative rebates. Spot metadata resolves source token indices; unavailable metadata leaves original codes intact.
- The initial socket open/subscription wait is bounded at 12 seconds. Confirmed subscriptions are distinguished from transport connection.
- REST failures retain last-good rows and suspend automatic REST retry. When only the stream fails, available REST refreshes recent fills every 60 seconds.
- Source timestamps and read timestamps remain separate. A stale leaderboard notice is scoped to the leaderboard rather than claiming that independently read account details are stale.
- The source page clarifies quote-price versus USDC margin/settlement units; notional amounts are not labeled as margin.
- Generation tokens, aborts and socket identity checks reject late messages from a previously selected account. Tables render source strings with text nodes.

## Local validation

`node audit/account-live-unit.cjs` passed 24 tests in this workspace: 23 portable mocked tests and one optional comparison against the actual captured responses. The actual-response test is omitted when capture files are absent, so CI does not claim to have performed a live-source check. No tests send network requests.

Static checks cover exact REST/WS CSP hosts, one deferred client script, content-hash versions, loading order, the initially hidden activity tab and absence of password fields. Browser verification and deployment status are established separately by the root agent.

## Operational limits

The panel is foreground-only and retains at most 200 fills/events in memory. It is not a permanent recorder for all 200 leaderboard accounts. Reconnection can leave gaps; a recent REST resynchronization does not establish complete historical coverage. Position/open-order reads use the default perpetual DEX scope; fills may include other source-reported markets.

Official references: [subscriptions](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions), [rate limits](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits), [contract specifications](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/contract-specifications).
