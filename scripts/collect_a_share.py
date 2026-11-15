#!/usr/bin/env python3
"""Run the local A-share collector and the existing offline research rules.

This command is intentionally manual.  It never places orders and it never
starts a scheduler.  Public publication requires an explicit rights flag and
is separate from local collection.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.stock_research import a_share_sources
from tools.stock_research import intraday_preselect
from tools.stock_research import pipeline


def write(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", choices=("auto",) + a_share_sources.PROVIDERS, default="auto")
    parser.add_argument("--mode", choices=("eod", "a14"), default="eod")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "research-data" / "local-a-share")
    parser.add_argument("--max-symbols", type=int)
    parser.add_argument("--public", action="store_true")
    parser.add_argument("--redistribution-allowed", action="store_true")
    parser.add_argument("--adjustment-attested", action="store_true")
    parser.add_argument("--calendar-attested", action="store_true")
    parser.add_argument("--publish-snapshot", action="store_true",
                        help="replace research-data/snapshot.json after public rights checks")
    args = parser.parse_args(argv)
    if args.public and not args.redistribution_allowed:
        parser.error("--public requires --redistribution-allowed")
    if args.publish_snapshot and not args.public:
        parser.error("--publish-snapshot requires --public")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    try:
        if args.mode == "eod":
            raw = a_share_sources.build_stock_input(
                args.provider, public=args.public, redistribution_allowed=args.redistribution_allowed,
                adjustment_attested=args.adjustment_attested, max_symbols=args.max_symbols,
            )
            raw_path = args.output_dir / "books.stock.input.json"
            snapshot_path = args.output_dir / "snapshot.json"
            write(raw_path, raw)
            previous = None
            if args.publish_snapshot and (ROOT / "research-data" / "snapshot.json").exists():
                previous = json.loads((ROOT / "research-data" / "snapshot.json").read_text(encoding="utf-8"))
            snapshot = pipeline.build(raw, previous=previous, now=datetime.now(timezone.utc).timestamp())
            write(snapshot_path, snapshot)
            if args.publish_snapshot:
                write(ROOT / "research-data" / "snapshot.json", snapshot)
            result = {"mode": args.mode, "input": str(raw_path), "snapshot": str(snapshot_path),
                      "status": snapshot["markets"]["a"]["status"], "published": args.publish_snapshot}
        else:
            baseline = args.output_dir / "a14-baseline.json"
            raw = a_share_sources.build_a14_input(
                args.provider, baseline_path=baseline, public=args.public,
                redistribution_allowed=args.redistribution_allowed,
                adjustment_attested=args.adjustment_attested, calendar_attested=args.calendar_attested,
                max_symbols=args.max_symbols,
            )
            raw_path = args.output_dir / "books.a14.input.json"
            result_path = args.output_dir / "books.a14.preselection.json"
            write(raw_path, raw)
            result_value = intraday_preselect.preselect(raw)
            intraday_preselect._write_atomic(result_path, result_value)
            a_share_sources.update_baseline(baseline, raw)
            result = {"mode": args.mode, "input": str(raw_path), "result": str(result_path),
                      "status": result_value["status"], "counts": result_value.get("counts"),
                      "baseline": str(baseline), "published": False}
    except (a_share_sources.ProviderError, OSError, ValueError, TypeError, KeyError) as error:
        code = error.code if isinstance(error, a_share_sources.ProviderError) else type(error).__name__
        parser.exit(2, f"A-share run failed: {code}\n")
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
