#!/usr/bin/env python3
"""Read-only comparison of native reader content, moved book controls and generated output."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import runpy
from urllib.parse import unquote, urlsplit
from bs4 import BeautifulSoup


def text(node):
    return re.sub(r'\s+', ' ', node.get_text(' ', strip=True)).strip()


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--site', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    source, site = args.source.resolve(), args.site.resolve()
    builder = runpy.run_path(str(site.parent / 'scripts/build_trader_academy.py'))
    names = {row['slug']: row['name'] for row in json.loads((site / 'catalog.json').read_text())}
    records = []
    for path in sorted(source.glob('*/index.html')):
        slug = path.parent.name
        target = site / slug / 'index.html'
        original = BeautifulSoup(path.read_text(), 'html.parser')
        adapted = BeautifulSoup(target.read_text(), 'html.parser')
        original_ids = Counter(node['id'] for node in original.select('[id]'))
        adapted_ids = Counter(node['id'] for node in adapted.select('[id]'))
        original_scripts = [str(node.string or '') for node in original.select('script:not([src])')]
        adapted_scripts = [str(node.string or '') for node in adapted.select('script:not([src])')]
        book = None
        if slug == 'laoemo':
            original_nav = original.select_one('nav.toolbar-panel')
            adapted_nav = adapted.select_one('nav.toolbar-panel.academy-book-toc')
            original_controls = [(node.name, node.get('id'), node.get('href'), node.get('role'), node.get('aria-selected'))
                                 for node in original_nav.select('button, a')]
            adapted_controls = [(node.name, node.get('id'), node.get('href'), node.get('role'), node.get('aria-selected'))
                                for node in adapted_nav.select('button, a')]
            chapter_links = [node['href'][1:] for node in adapted_nav.select('a[href^="#"]')]
            pdf_source = source / 'laoemo/laoemo-contracts.pdf'
            pdf_target = site / 'laoemo/laoemo-contracts.pdf'
            book = {
                'navigationTextEqual': text(original_nav) == text(adapted_nav),
                'controlsEqual': original_controls == adapted_controls,
                'navigationMovedToSidebar': adapted_nav.parent.get('class') == ['layout-container', 'academy-book-layout'],
                'navigationStillInMain': bool(adapted.select_one('main.page-wrap nav.toolbar-panel')),
                'chapterTargets': chapter_links,
                'missingChapterTargets': [key for key in chapter_links if adapted_ids[key] != 1],
                'pdfBytes': pdf_target.stat().st_size,
                'pdfSha256': sha(pdf_target),
                'pdfEqualsSource': sha(pdf_source) == sha(pdf_target),
                'nativePdfLazyPathPreserved': "pdfFrame.src = 'laoemo-contracts.pdf#view=FitH'" in '\n'.join(adapted_scripts),
            }
            original_nav.extract()
        selector = '.main-content, main.main, main.page-wrap'
        original_text = text(original.select_one(selector))
        adapted_text = text(adapted.select_one(selector))
        resources = []
        for node in adapted.select('img[src], script[src], link[href], iframe[src], embed[src], object[data], a[href]'):
            value = node.get('src') or node.get('href') or node.get('data')
            parts = urlsplit(value)
            if not parts.scheme and not parts.netloc and parts.path:
                resources.append((value, target.parent / unquote(parts.path)))
        raw_copy = site / '_source' / slug / 'index.html'
        record = {
            'slug': slug,
            'bodyTextEqualAfterMovedControlExclusion': original_text == adapted_text,
            'bodyTextCharacters': len(original_text),
            'originalInlineScriptsEqual': original_scripts == adapted_scripts,
            'originalInlineScriptCount': len(original_scripts),
            'originalIdCount': sum(original_ids.values()),
            'missingOriginalIds': dict(original_ids - adapted_ids),
            'introducedDuplicateIds': {key: value for key, value in adapted_ids.items() if value > max(1, original_ids[key])},
            'rawSourceCopyEqual': raw_copy.is_file() and sha(path) == sha(raw_copy),
            'localResourceChecks': len(resources),
            'missingLocalResources': sorted({value for value, resource in resources if not resource.exists()}),
            'generatedHtmlExact': builder['adapt'](path, slug, names[slug]) == target.read_text(),
            'readerStyle': adapted.select_one('link[href*="reader.css"]')['href'],
            'readerInteraction': adapted.select_one('script[src*="reader-ui.js"]')['src'],
            'bookControls': book,
        }
        records.append(record)
    content_passed = all(row['bodyTextEqualAfterMovedControlExclusion'] and row['originalInlineScriptsEqual']
                         and row['rawSourceCopyEqual'] and not row['missingOriginalIds']
                         and not row['introducedDuplicateIds'] and not row['missingLocalResources'] for row in records)
    book = next(row['bookControls'] for row in records if row['slug'] == 'laoemo')
    book_passed = (book['navigationTextEqual'] and book['controlsEqual'] and book['navigationMovedToSidebar']
                   and not book['navigationStillInMain'] and not book['missingChapterTargets']
                   and book['pdfEqualsSource'] and book['nativePdfLazyPathPreserved'])
    synchronized = all(row['generatedHtmlExact'] for row in records)
    report = {
        'checkedAt': datetime.now(timezone.utc).isoformat(),
        'scope': 'Local files only. Excludes Books shell and external bridge scripts; does not prove browser event or deployed HTTP behavior.',
        'source': str(source), 'site': str(site),
        'contentPassed': content_passed, 'bookControlMovePassed': book_passed,
        'generationSynchronized': synchronized,
        'readerCount': len(records),
        'originalIdCount': sum(row['originalIdCount'] for row in records),
        'bodyTextCharacters': sum(row['bodyTextCharacters'] for row in records),
        'localResourceChecks': sum(row['localResourceChecks'] for row in records),
        'unsynchronizedReaders': [row['slug'] for row in records if not row['generatedHtmlExact']],
        'readers': records,
        'passed': len(records) == 16 and content_passed and book_passed and synchronized,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({key: report[key] for key in ['passed','contentPassed','bookControlMovePassed','generationSynchronized','readerCount','originalIdCount','bodyTextCharacters','localResourceChecks','unsynchronizedReaders']}, ensure_ascii=False))
    print('Report:', args.output)


if __name__ == '__main__':
    main()
