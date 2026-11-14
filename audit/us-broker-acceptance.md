# Three free-entitlement quote adapters — 2026-11-15

Public entry: `us-live.html`; manually started helper: `tools/us_broker_quotes/server.py`; reproducible standalone download: `downloads/books-free-broker-quotes.zip`.

Implemented read paths only:

- Futu fixed official REST stock quote with the user's own quote token, or explicit localhost OpenD snapshot. No login password, OAuth registration, authorization creation, market-data purchase or trading method is called.
- Longbridge fixed official AP `.cn` signed HTTP stock quote. Uses the exact v5.4.0 canonical signing scheme and an independently checked OpenSSL fixture. A direct standard-library transport avoids the official SDK's automatic HTTP429 retries. US-region and OAuth Bearer credentials are explicitly unsupported in this version; no alternate host is selected.
- Tiger official SDK `get_stock_delay_briefs` only. No paid realtime fallback. Output is always labelled approximately 15 minutes delayed. SDK environment/file loads, retries, token persistence, dynamic domains, permission grabbing and SDK logging are disabled or refused.

The helper binds only 127.0.0.1:19355. Strict Host, Origin, 256-bit pairing token, route/body/header limits and a local-only credential entry gate protect it. Each provider has a shared manual-read budget across browser tabs. Platform credentials remain in service RAM; the public page holds only the pairing token in RAM. The public page cannot submit platform credentials. Stop records contain only safe provider/reason/timestamp values. HTTP403/429 and explicit native permission/rate-limit errors persist a source stop.

Verification completed:

- Offline provider and service tests cover the official quote response shapes, preserved source times, independent signing vector, raw epoch fields, unavailable rows, free-only confirmation, source stops across reconnect/restart, Origin/Host protection, disconnect races and cross-tab budgets.
- Browser controller fixtures cover all three selectors and quote paths, Tiger delay, pairing RAM, cancellation, missing data, platform isolation and absence of fabricated minute radar signals.
- Official packages were installed in a separate local venv for interface inspection: futu-api 10.12.7208, tigeropen 3.9.1 and longbridge 5.4.0. The production Longbridge adapter no longer needs that SDK. Installing or inspecting packages is not a real quote acceptance test.
- Actual local HTTP status GET returned no connected providers, background disabled and zero orders. Actual private-network CORS preflight returned 204 for the public Pages origin. A browser actually paired with a credential-free QA service and displayed the real not-connected error on quote requests. No synthetic vendor prices were seeded into the browser.
- Desktop and 390px mobile layouts were checked. The downloaded ZIP is generated from five explicitly listed source files and excludes all credentials, runtime state, fixtures and installed dependencies.

Still pending:

- The owner's real platform credentials, eligibility and current free quote entitlements have not been supplied or verified. No authenticated vendor quote, live update or completed-minute baseline has been accepted. An adapter connection is not displayed as verified realtime data.
- These adapters provide snapshots. Cumulative session volume is never treated as minute volume, and no 10–20 day minute baseline is asserted. Their data is not mixed with the optional legacy IEX workspace.
- Source code/public page access is separate from permission to redistribute personal market data. No owner quote data or credentials are published as GitHub JSON.

No new schedule, live-trading change, purchase or exchange order was created. Existing unrelated private-site work was preserved and excluded from this publication.
