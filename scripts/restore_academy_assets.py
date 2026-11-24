"""Restore immutable reader assets from the pinned upstream checkout; never replace UI."""
import argparse
import hashlib
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def verify(path, record):
    data = path.read_bytes()
    if len(data) != record['bytes'] or hashlib.sha256(data).hexdigest() != record['sha256']:
        raise ValueError(f"Asset differs from pinned source: {path}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path, help='Checkout of the commit in academy/source-manifest.json')
    parser.add_argument('--site', type=Path, default=ROOT, help='Existing site root; UI files stay unchanged')
    parser.add_argument('--verify-only', action='store_true', help='Verify installed assets without writing')
    args = parser.parse_args()
    manifest = json.loads((ROOT / 'academy/source-manifest.json').read_text())
    for record in manifest['files']:
        target = args.site / 'academy' / record['path']
        if args.verify_only:
            verify(target, record)
            continue
        source = args.source / record['sourcePath']
        verify(source, record)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    print(f"Verified {len(manifest['files'])} reader assets from {manifest['repository']}@{manifest['commit']}")


if __name__ == '__main__':
    main()
