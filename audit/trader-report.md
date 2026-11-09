# Trader research page verification

## Change

Removed the AlphaFox dependency notice and rebuilt the trader page around compact research cards, real period labels, source links and optional browser-local records. Record management is a collapsed secondary control. The shared sidebar, scrolling ticker, other market pages and public feed are unchanged.

The page can add/edit/delete local records, validate/import JSON and export a backup. Local and public rows are separate; a public fetch failure cannot erase private records. Corrupt local storage blocks later writes instead of overwriting the unreadable original. Storage failures do not report success. Saving a low-ranked record reveals its actual result page.

The OKX converter is offline only. Raw snapshots have unknown source time and no imported curve. A wrapper with an explicit collection timestamp can retain valid source points. No calculated drawdown, trade win rate, positions or orders are invented. No exchange API polling is enabled; one cloud probe returned HTTP 403. No API response or synthetic trader fixture is in the production feed.

## Automated checks

- `node --check trader/plaza.js` and `node --check trader/okx-import.js`: passed.
- `node audit/trader-unit.cjs`: 46 logic/DOM-model tests passed.
- `node audit/okx-import-unit.cjs`: 13 offline adapter tests passed.
- `python audit/site-static.py`: 614 assertions passed across 12 HTML documents, including shared-shell/resource/cache checks.
- Independent read-only review: no remaining release-blocking findings.

The DOM-model tests do not establish browser layout, native dialog behavior, or persistence in a real browser. Live deployment and browser interaction checks are performed after publishing and reported with the release. All test identities and numbers remain synthetic fixtures in tests, never production data.
