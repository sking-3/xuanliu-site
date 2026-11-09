# Trader research page verification

## Current scope

The trader page no longer exposes file import or export. Buttons, file input, associated handlers and transfer-related instructions were removed in accordance with the user's earlier preference. The page no longer loads the offline OKX adapter. Its standalone module and tests remain developer preparation only, not a working online data source.

Optional local add/edit/delete remains in the secondary record-management control. Existing browser records are retained; legacy snapshot time labels remain readable. A corrupt local store blocks writes rather than overwriting the original. Public feed failures cannot erase personal records.

The AlphaFox notice remains removed. Shared navigation, ticker and other pages are unchanged. Production feed remains empty; no synthetic identities or performance figures are published. The single prior official OKX GET returned HTTP 403; no retry or proxy workaround was performed and no online collection is enabled.

## Verification

- `node --check trader/plaza.js`: passed.
- `node audit/trader-unit.cjs`: 47 logic and DOM-model tests passed, including absence of removed script entry points and preservation of old records.
- `python audit/site-static.py`: 615 assertions across 12 HTML documents, including absence of transfer controls, instructions and adapter loading.
- Every literal script DOM ID exists in the updated HTML.
- The previous release was verified in cloud Chrome. This corrective release is checked after GitHub Pages deployment for removed entries and retained record editing.

Test fixtures are synthetic and remain confined to test processes. DOM-model checks do not substitute for actual browser verification.
