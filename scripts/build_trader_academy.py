"""Import a pinned Trader-Archives checkout, retaining native readers and raw assets."""
import argparse
import hashlib
import html
import json
import re
import shutil
from pathlib import Path
from bs4 import BeautifulSoup

REVISION = '5e18e9a752719264508dc00be093e75c8b7f1824'
VERSION = 'academy-20261124-2'
SHELL_VERSION = 'shell-motion-20261124-2'
DIRECTORY_VERSION = 'directory-flow-20261124-1'
READER_STYLE_VERSION = 'reader-follow-20261124-4'
READER_UI_VERSION = 'reader-follow-20261124-2'
SLUGS = ['thankucrypto', 'xiaomu', 'michael-liu', 'cj', 'yourquantguy', 'metabape',
         'coolish', 'wallstreet0name', '0xcryptowizard', '0xsun', 'kuigas', 'web3feng',
         '0xmagnolia', 'agintender', 'ztzzbtc', 'laoemo']
NAV = [('index.html', '市场总览'), ('screening/index.html', 'A股选股'), ('us.html', '美股选股'),
       ('trader/index.html', '带单员广场'), ('research.html', '公司研究'),
       ('screening/history.html', '历史研究'), ('academy/index.html', '交易员研习'), ('tools.html', '研究工具')]


def esc(value):
    return html.escape(str(value), quote=True)


def shell(prefix):
    links = ''.join(f'<a href="{prefix}{url}"' + (' aria-current="page"' if title == '交易员研习' else '')
                    + f'>{title}</a>' for url, title in NAV)
    return f'''<section class="index-ticker" id="index-ticker" aria-label="全球指数行情"><iframe src="{prefix}market-strip.html?v=compact-20261123-1" title="全球指数行情"></iframe></section>
<a class="skip" href="#academy-content">跳至正文</a>
<aside class="books-sidebar" aria-label="研究导航"><a class="books-brand" href="{prefix}index.html">Books<span>RESEARCH STUDIO</span></a><nav class="books-nav" aria-label="工作区">{links}</nav><nav class="books-shortcuts" aria-label="行情快捷入口"><a href="{prefix}a-shares.html">A股行情</a><a href="{prefix}us-live.html">美股监控</a><a href="{prefix}crypto.html">加密行情</a></nav><p class="books-side-note">独立研究 · 证据优先</p></aside>'''


def shared_head(prefix, reader=False):
    css = ['books-ui.css?v=40832f3c', 'index-ticker.css?v=compact-20261123-1',
           'desk-skin.css?v=ui-motion-20261124-1',
           'content-materials.css?v=' + ('natural-layout-20261123-1' if reader else DIRECTORY_VERSION)]
    tags = ''.join(f'<link rel="stylesheet" href="{prefix}{url}">' for url in css)
    tags += f'<link rel="stylesheet" href="{"../" if reader else ""}{"reader" if reader else "library"}.css?v={READER_STYLE_VERSION if reader else DIRECTORY_VERSION}">'
    tags += f'<script defer src="{prefix}index-ticker.js?v=compact-20261123-1"></script><script defer src="{prefix}books-shell.js?v={SHELL_VERSION}"></script>'
    return tags


def catalog(source):
    root = BeautifulSoup((source / 'index.html').read_text(), 'html.parser')
    people = []
    for card in root.select('.kol-card:not(.card-future)'):
        link = card.select_one('.kol-actions a')
        slug = link['href'].strip('/') if link else ''
        if slug not in SLUGS:
            continue
        get = lambda selector: card.select_one(selector).get_text(' ', strip=True)
        people.append(dict(slug=slug, name=get('.kol-name'), handle=get('.kol-handle'),
                           title=get('.kol-book-title'), focus=get('.kol-card-ribbon').lstrip('🔥 '),
                           description=get('.kol-summary'), avatar=card.select_one('img')['src'],
                           tags=[x.get_text(' ', strip=True) for x in card.select('.kol-tag') if 'RAG' not in x.text],
                           stats=[x.get_text(' ', strip=True) for x in card.select('.kol-key-stats > div')], kind='trader'))
    people.append(dict(slug='laoemo', name='老恶魔', handle='交易专著', title='《老恶魔谈合约》',
                       focus='合约交易 · 完整典藏', description='完整阅读《老恶魔谈合约》，浏览原有章节并下载高清 PDF。',
                       avatar='laoemo/images/laoemo_profile.jpg', tags=['合约交易', '章节阅读', '高清 PDF'],
                       stats=['完整典藏', 'PDF 下载'], kind='book'))
    return people


def hub(people):
    cards = []
    for p in people:
        tags = ''.join(f'<li>{esc(t)}</li>' for t in p['tags'])
        stats = ''.join(f'<span>{esc(t)}</span>' for t in p['stats'])
        cards.append(f'''<article class="academy-person" data-kind="{p['kind']}" data-search="{esc(' '.join([p['name'], p['handle'], p['title'], p['focus'], *p['tags']]).lower())}">
<header class="academy-person-heading"><div class="academy-avatar"><img src="{esc(p['avatar'])}" alt="{esc(p['name'])}" loading="lazy" width="48" height="48"></div>
<div class="academy-person-title"><h2>{esc(p['name'])}</h2><p>{esc(p['handle'])}</p></div>
<a class="academy-enter" href="{p['slug']}/index.html"><span>进入{'专著' if p['kind']=='book' else '研习'}</span><span aria-hidden="true">↗</span></a></header>
<p class="academy-focus">{esc(p['title'])}</p><p class="academy-description">{esc(p['description'])}</p>
<footer class="academy-person-foot"><ul class="academy-tags">{tags}</ul><div class="academy-person-meta">{stats}</div></footer></article>''')
    return f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>交易员研习 · Books</title>
{shared_head('../')}<script defer src="library.js?v={VERSION}"></script></head><body class="books-shell academy-page">{shell('../')}
<main class="academy-main" id="academy-content"><header class="academy-heading"><div><h1>交易员研习</h1><p>沿着目录读原文，在实战记录中理解交易方法。</p></div><dl class="academy-summary"><div><dd>15</dd><dt>位交易员</dt></div><div><dd>1</dd><dt>部专著</dt></div></dl></header>
<form class="academy-toolbar" role="search"><label>查找交易员或主题<input id="academy-search" type="search" placeholder="名称、做空、仓位、宏观、套利…" autocomplete="off"></label><label>资料类型<select id="academy-kind"><option value="all">全部资料</option><option value="trader">交易员资料</option><option value="book">交易专著</option></select></label></form>
<p id="academy-results" role="status">共 16 个资料入口</p><section class="academy-grid books-content-list" aria-label="研习目录">{''.join(cards)}</section><p id="academy-empty" hidden>没有匹配的资料，请换一个名称或主题。</p>
<footer class="academy-source"><p>资料保留原站的章节、原文记录、长文与配图；简介和数据量沿用原仓库标注。阅读、目录、搜索和图片使用本站保存的文件。</p><p>来源：<a href="https://github.com/suoha888/Trader-Archives/tree/{REVISION}" target="_blank" rel="noopener">Trader-Archives</a> · <a href="LICENSE">MIT 许可</a> · 固定版本 {REVISION[:12]}</p></footer></main></body></html>'''


def local_url(value, slug):
    base = 'https://suoha888.github.io/Trader-Archives/'
    raw_base = 'https://github.com/suoha888/Trader-Archives/blob/main/'
    if value.startswith(raw_base):
        value = '../' + value[len(raw_base):]
    if value.startswith(base):
        value = '../' + value[len(base):]
    if value in ('..', '../', '../index.html'):
        return '../index.html'
    if value in ('./', '.'):
        return 'index.html'
    if re.fullmatch(r'(\.\./)?(' + '|'.join(SLUGS) + r')/?', value):
        return value.rstrip('/') + '/index.html'
    return value


def adapt(path, slug, name):
    raw = path.read_text()
    doc = BeautifulSoup(raw, 'html.parser')
    # Remote fonts are presentation only. Keep all native content and inline readers.
    for tag in doc.select('link[href]'):
        if any(domain in tag['href'] for domain in ['fonts.googleapis.com', 'fonts.gstatic.com']):
            tag.decompose()
    for tag in doc.select('[href]'):
        tag['href'] = local_url(tag['href'], slug)
    for tag in doc.select('img[onerror]'):
        del tag['onerror']
    doc.body['class'] = [*doc.body.get('class', []), 'books-shell', 'academy-reader-page']
    doc.title.string = f'{name} · 交易员研习 · Books'
    doc.head.append(BeautifulSoup(shared_head('../../', reader=True), 'html.parser'))
    # Explicitly prevent the upstream AI gateway from being a runtime dependency.
    csp = doc.new_tag('meta', attrs={'http-equiv': 'Content-Security-Policy', 'content': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'self'; base-uri 'self'"})
    doc.head.insert(1, csp)
    toolbar = f'''{shell('../../')}<nav class="academy-reader-toolbar" aria-label="阅读导航"><a href="../index.html">‹ 交易员研习</a><span>{esc(name)}</span><button id="academy-toc-toggle" type="button" aria-controls="academy-toc-dialog" aria-expanded="false">章节目录</button></nav>'''
    doc.body.insert(0, BeautifulSoup(toolbar, 'html.parser'))
    main = doc.select_one('.main-content, main.main, main.page-wrap')
    if main and not main.get('id'):
        main['id'] = 'academy-content'
    else:
        skip = doc.select_one('.skip'); skip['href'] = '#' + main['id'] if main else '../index.html'
    if slug == 'laoemo':
        navigation = doc.select_one('nav.toolbar-panel')
        navigation['class'] += ['sidebar', 'academy-book-toc']
        layout = doc.new_tag('div', attrs={'class': 'layout-container academy-book-layout'})
        main.wrap(layout)
        layout.insert(0, navigation.extract())
    doc.body.append(BeautifulSoup(f'<script defer src="../reader-ui.js?v={READER_UI_VERSION}"></script>', 'html.parser'))
    return str(doc)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--preview', action='store_true')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    people = catalog(args.source)
    if not args.preview:
        shutil.copytree(args.source, args.output, dirs_exist_ok=True)
    manifest = {'repository': 'suoha888/Trader-Archives', 'commit': REVISION, 'readers': []}
    for p in people:
        path = args.source / p['slug'] / 'index.html'
        if not path.exists() and args.preview:
            continue
        dest = args.output / p['slug'] / 'index.html'
        dest.parent.mkdir(parents=True, exist_ok=True)
        original = args.output / '_source' / p['slug'] / 'index.html'
        original.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, original)
        dest.write_text(adapt(path, p['slug'], p['name']))
        manifest['readers'].append({'slug': p['slug'], 'sourceSha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    (args.output / 'index.html').write_text(hub(people))
    (args.output / 'catalog.json').write_text(json.dumps(people, ensure_ascii=False, indent=2))
    (args.output / 'import-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    shutil.copyfile(args.source / 'LICENSE', args.output / 'LICENSE')
    print(json.dumps({'readers': len(manifest['readers']), 'catalog': len(people), 'commit': REVISION}))


if __name__ == '__main__':
    main()
