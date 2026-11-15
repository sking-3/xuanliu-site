# Copy gateway dry-run contract

This directory contains an offline-only event contract and deterministic paper ledger. It deliberately has no HTTP client, WebSocket client, credential storage, exchange SDK, signing code, or order endpoint.

A source adapter must provide normalized events with:

- `source`, `eventId`, and `identity`: stable source and version identifiers;
- `symbol`, `side`, `action`, `quantity`, `price`;
- `sourceTime`, `firstSeenAt`, `observedAt` in epoch milliseconds;
- optional `sequence` when the source guarantees an ordering key;
- optional `positionBefore` / `positionAfter` when the source discloses complete position state.

The engine rejects stale/future/malformed events, deduplicates exact event keys, rejects revised identities, and marks same-time events without a source sequence as `ambiguous_event_order`. `baseline()` records historical observations without simulating orders. `apply()` only mutates the local dry-run ledger and every decision has `mode: "dry_run"` and `sent: false`.

This is a safety boundary and test harness, not a broker adapter or a production copy-trading service.
