"""Local resource, document semantics and truthful-preview regression checks."""
from pathlib import Path
from lxml import html
from urllib.parse import urlsplit, unquote, parse_qs
import json,re
root=Path(__file__).resolve().parents[1]
checks=0

def check(ok,msg):
 global checks
 assert ok,msg
 checks+=1

pages=list(root.rglob('*.html'))
for p in pages:
 tree=html.fromstring(p.read_text())
 ids=tree.xpath('//@id')
 check(len(ids)==len(set(ids)),f'{p.name}: duplicate IDs')
 for node in tree.xpath('//*[@href or @src]'):
  ref=node.get('href') or node.get('src');u=urlsplit(ref)
  if u.scheme or u.netloc:continue
  target=(p.parent/unquote(u.path)) if u.path else p
  if target.is_dir():target=target/'index.html'
  check(target.is_file(),f'{p}: missing {ref}')
  if u.fragment:
   targettree=html.fromstring(target.read_text());check(bool(targettree.xpath('//*[@id=$id]',id=unquote(u.fragment))),f'{p}: missing fragment {ref}')
 if not tree.xpath('//body[contains(@class,"books-shell")]'):continue
 check(len(tree.xpath('//main'))==1,f'{p}: one main landmark')
 check(len(tree.xpath('//h1'))==1,f'{p}: one page heading')
 check(len(tree.xpath('//script[contains(@src,"books-shell.js")]'))==1,f'{p}: shared navigation loaded once')
 check(bool(tree.xpath('//a[contains(@class,"skip")]')),f'{p}: keyboard bypass exists')
 check(bool(tree.xpath('//meta[@http-equiv="Content-Security-Policy"]')),f'{p}: CSP retained')
 for table in tree.xpath('//table'):
  columns=len(table.xpath('.//thead/tr[1]/th'))
  for td in table.xpath('.//tbody/tr/td[@colspan]'):check(int(td.get('colspan'))==columns,f'{p}: empty row matches {columns} columns')
 for section in tree.xpath('//section[contains(concat(" ",@class," ")," public-feed ")]'):
  configs=section.xpath('.//script[@data-feed-config]');check(len(configs)==1,f'{p}: one feed config')
  config=json.loads(configs[0].text)
  for cls in ['feed-status','feed-retry','feed-toggle','feed-source']:
   check(len(section.xpath('.//*[contains(concat(" ",@class," "),$cls)]',cls=' '+cls+' '))==1,f'{p}: feed {cls}')
  check(not section.xpath('.//script[@src]'),f'{p}: provider mounted only by recovery code')
  check('largeChartUrl' in config,f'{p}: stays in site charts')
  check(bool(section.xpath('.//details[contains(@class,"symbol-shortcuts")]')),f'{p}: direct chart fallback')
  check(bool(tree.xpath('//script[contains(@src,"market-feed-status.js")]')),f'{p}: recovery code included')
chart_source=(root/'chart.js').read_text()
supported=set(re.findall(r"\['([A-Z0-9]+:[A-Z0-9]+)'",chart_source))
for p in pages:
 tree=html.fromstring(p.read_text())
 for link in tree.xpath('//a[@href]'):
  q=parse_qs(urlsplit(link.get('href')).query)
  if 'tvwidgetsymbol' in q:check(q['tvwidgetsymbol'][0] in supported,f'{p}: unsupported chart link')
feed=json.loads((root/'trader/feed.json').read_text())
check(feed['status']=='unavailable' and feed['traders']==[], 'Real trader data unavailable, no fake rows')
check('本页无外部请求' not in (root/'screening/history.html').read_text(),'External source disclosure correct')
check('"showChart":false' in (root/'index.html').read_text(),'Home compact market cards preserved')
# Core charts/header files owned by a separate task must remain byte-identical.
import subprocess
for path in ['index-ticker.css','index-ticker.js','market-strip.css','market-strip.js','market-strip.html','trader/feed.json']:
 baseline=subprocess.check_output(['git','show','HEAD:'+path],cwd=root)
 check((root/path).read_bytes()==baseline,f'{path}: unrelated/header/data unchanged')
print(f'PASS {checks} static assertions across {len(pages)} HTML documents (11 full pages + shared strip).')
