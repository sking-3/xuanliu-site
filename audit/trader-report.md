# Trader interaction audit

Scope: trader/plaza.js only; no production feed, HTML, CSS, deployment or external data changes.

## Fixed
- Search query and pagination now round-trip through URL state. Initial page survives asynchronous feed loading, filters/reset and pagination update history, and Back/Forward restores query and page. Search typing replaces the current history entry to avoid one entry per keystroke.
- Invalid and missing page parameters default safely; pagination is clamped to available results after loading.
- Feed validation rejects impossible/non-ISO calendar dates, empty identities, malformed records/curve points, and window/trade timestamps newer than collection. Existing null metric semantics, same-currency ranking, missing-last sort, curve bounds, and per-trade win-rate rules remain intact.
- Tiny crypto amounts retain eight decimals or scientific notation instead of rounding to a misleading zero.
- Refresh exposes an accessible busy state, continues to deduplicate repeated requests, and restores focus when a refresh invalidates the focused card/detail. Initial page loading no longer deliberately moves focus.
- Detail opens with explicit Close-button focus. Arrow Left/Right and Home/End navigate detail view buttons. Native dialog Escape, focus containment and opener restoration remain native; Back/Forward dismisses detail before rebuilding results.
- Invalid feeds continue to clear stale results and close details. Ready-but-empty and unavailable remain separate truthful states.

## Verification
- PASS: `node --check trader/plaza.js`
- PASS: `node audit/trader-unit.cjs` (23 synthetic unit/DOM-model checks; output in trader-unit-results.txt).
- Prepared but NOT RUN: `node audit/trader-tests.cjs` real-browser regression, including native Escape/focus behavior. Initial launch failed because Playwright's bundled executable was absent. Parent separately identified a cloud socket restriction and requested no further browser launch attempts here. DOM-model tests do not establish real-browser layout, native dialog focus, or history behavior.
- No synthetic record is deployed. Fixtures are confined to test processes; production feed remains unavailable.

## Optional UI suggestions for parent
- Maintain visible focus rings on detail-view buttons and close button; ensure the dialog fits narrow viewports and its scroll region is usable.
- Keep the truthful unavailable notice, explicit same-currency constraint, and per-card freshness labels prominent after styling.
