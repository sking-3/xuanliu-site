# Corrective compact-state update

The published UI was checked against the user’s two mobile screenshots. The extra loading/status, retry/collapse/source action row and direct-chart disclosure had been reintroduced during the resilience work. They are now hidden without allocating space in normal/loading states. The collapse button is removed. Minimal recovery actions and chart alternatives appear only after an explicit failure. Required TradingView attribution stays visible; no iframe cropping or branding concealment is used. See the official attribution FAQ: https://www.tradingview.com/widget-docs/faq/general/

The original prepublication audit below is retained as historical context, not current release status. The first release was 3c1d808 with a successful Pages deployment and an 11-page live desktop regression. Narrow-device testing remained unverified because the cloud browser’s developer tools are disabled by organization policy.

---

# Books site bug and UI audit

Baseline: `a49e680aea74ae08ad0a134775cef5c98d9d3917` on public main.

## Implemented candidate

1. Restored market loading/recovery controls on home, A-share, US and crypto pages. The old loader existed but was not included by these pages. A single config now drives each widget; script errors/timeouts collapse blank regions, allow retry and retain an external source link and TradingView attribution. Provider response never claims verified prices. Obsolete retry errors and unrelated postMessages are ignored.
2. Added direct internal chart links for every listed security. A failed embedded overview no longer prevents opening the corresponding chart. The chart page now has a grouped symbol picker, a market-specific return link, no large blank panel for unsupported/missing parameters, controlled retry state and descriptive iframe titles. Bare `000001` still requires explicit stock/index selection. FRED remains a close-only line.
3. Improved shared white sidebar and responsive navigation. Mobile disclosure supports keyboard Escape, focus recovery on viewport changes, visible touch-sized controls, a no-JavaScript fallback and functional skip-link focus. Page spacing and empty states are more compact; focus states are visible.
4. Fixed trader URL search/pagination and Back/Forward restoration, validation of impossible dates and inconsistent observation times, small crypto quantities rounded to zero, refresh status and keyboard detail navigation. No trader feed was added or changed.
5. Fixed empty table colspans, empty pagination, homepage missing heading, stale/contradictory wording and misleading unavailable preview prompts. Top ticker assets are deliberately untouched to avoid conflict with concurrent work.

## Verification completed

- 479 static assertions across 12 HTML documents (11 complete pages and the shared strip): local links/assets/fragments, duplicate IDs, heading/main landmarks, CSP retention, feed control/config integration, chart symbol allowlist, empty table spans and unchanged provider/feed boundary.
- 23 synthetic trader validation/DOM-model tests.
- 13 market/chart DOM-model tests: errors, retry, stale callbacks, provider-origin filtering, missing/ambiguous symbols, canonicalization, chart type and loading semantics.
- Shared shell DOM-model tests: desktop/mobile disclosure, Escape, resize focus recovery, skip focus, pageshow and duplicate init.
- JavaScript syntax checks and git whitespace check.
- Read-only live cloud-browser audit of all 11 public pages and the shared ticker at 1212 x 799. TradingView overview, ticker and SSE chart loaded; trader search, period, reset and disclosures worked; homepage had no horizontal overflow.
- HTTP 200 responses for every public HTML document and trader feed.

## Not yet verified / not published

- Live browser inspection above covers the old public baseline, NOT this candidate.
- Candidate visual regression, actual mobile rendering, and native dialog/history/focus behavior are NOT verified. Headless Chromium is blocked by the execution runtime's socket restriction; the available cloud-browser surface exposes neither documented local preview nor viewport emulation. No user desktop was accessed and no restriction was bypassed.
- These DOM-model tests do not substitute for browser rendering tests. `trader-tests.cjs` and `browser-site.cjs` are prepared real-browser suites, not passed suites. The whole-site suite covers 11 pages at 1440, 768, 390 and 320 pixels plus no-JavaScript navigation, with external providers intentionally blocked to test failure recovery.
- Research records, screening calculations, archive/export, personal accounts and trader data remain unavailable in this public preview. Disabled controls are intentional, not completed functionality.
- No remote push, merge or deployment has been performed by this audit. Local candidate completion is not production completion.

## Reproduce local checks

From the repository root:

```
node audit/trader-unit.cjs
node audit/market-chart-unit.cjs
node audit/shell-unit.cjs books-shell.js
python audit/site-static.py
node --check books-shell.js
node --check market-feed-status.js
node --check chart.js
node --check trader/plaza.js
git diff --check
```

No account, private data, API key or real trade fixture is used in these tests.
