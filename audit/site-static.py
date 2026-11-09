"""Local resource, document semantics and truthful-preview regression checks."""
from pathlib import Path
from lxml import html
from urllib.parse import urlsplit, unquote, parse_qs
import hashlib,json,re
root=Path(__file__).resolve().parents[1]
checks=0

def check(ok,msg):
 global checks
 assert ok,msg
 checks+=1

pages=list(root.rglob('*.html'))
attribution_counts={'index.html':3,'a-shares.html':1,'us.html':1,'crypto.html':1,'chart.html':1,'market-strip.html':1}
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
 attributions=tree.xpath('//*[@data-books-attribution or contains(concat(" ",normalize-space(@class)," ")," tradingview-widget-copyright ") or contains(concat(" ",normalize-space(@class)," ")," books-market-credit ")]')
 check(len(attributions)==attribution_counts.get(str(p.relative_to(root)),0),f'{p}: original attribution nodes retained')
 for node in attributions:
  check('hidden' in node.attrib and 'data-books-attribution' in node.attrib,f'{p}: site attribution stays hidden')
  check(not node.xpath('ancestor::*[@id="chart-widget" or contains(concat(" ",normalize-space(@class)," ")," feed-widget-area ") or contains(concat(" ",normalize-space(@class)," ")," tradingview-widget-container ")]'),f'{p}: attribution outside provider and retry hosts')
  check(bool(node.xpath('.//a[@href]')) and bool(node.text_content().strip()),f'{p}: original attribution text and link retained')
 visible_text=' '.join(tree.xpath('//body//text()[not(ancestor::script) and not(ancestor::style) and not(ancestor::*[@hidden])]'))
 check('TradingView' not in visible_text,f'{p}: no visible site-controlled provider caption')
 if not tree.xpath('//body[contains(@class,"books-shell")]'):continue
 check(len(tree.xpath('//main'))==1,f'{p}: one main landmark')
 check(len(tree.xpath('//h1'))==1,f'{p}: one page heading')
 check(len(tree.xpath('//script[contains(@src,"books-shell.js")]'))==1,f'{p}: shared navigation loaded once')
 check(bool(tree.xpath('//a[contains(@class,"skip")]')),f'{p}: keyboard bypass exists')
 check(bool(tree.xpath('//meta[@http-equiv="Content-Security-Policy"]')),f'{p}: CSP retained')
 frames=tree.xpath('//*[@id="index-ticker"]/iframe')
 check(len(frames)==1 and (p.parent/urlsplit(frames[0].get('src')).path).resolve()==root/'market-strip.html',f'{p}: one shared local ticker')
 for table in tree.xpath('//table'):
  columns=len(table.xpath('.//thead/tr[1]/th'))
  for td in table.xpath('.//tbody/tr/td[@colspan]'):check(int(td.get('colspan'))==columns,f'{p}: empty row matches {columns} columns')
 for section in tree.xpath('//section[contains(concat(" ",@class," ")," public-feed ")]'):
  configs=section.xpath('.//script[@data-feed-config]');check(len(configs)==1,f'{p}: one feed config')
  config=json.loads(configs[0].text)
  for cls in ['feed-status','feed-retry','feed-source']:
   check(len(section.xpath('.//*[contains(concat(" ",@class," "),$cls)]',cls=' '+cls+' '))==1,f'{p}: feed {cls}')
  check(not section.xpath('.//*[contains(concat(" ",@class," ")," feed-toggle ")]'),f'{p}: removed persistent collapse control')
  check(bool(section.xpath('.//div[contains(@class,"feed-controls")][@hidden]')),f'{p}: recovery controls hidden before JS')
  check(bool(section.xpath('.//details[contains(@class,"symbol-shortcuts")][@hidden]')),f'{p}: extra chart links hidden normally')
  check(len(section.xpath('.//div[@data-books-attribution][@hidden]'))==1,f'{p}: hidden market attribution retained')
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
# Preserve the latest concurrent navigation/trader work, without requiring a Git checkout.
base=root.parent/'attribution_base_20261110'
for path in ['books-shell.js','books-ui.css','index-ticker.js','trader/feed.json','trader/plaza.js']:
 check((root/path).read_bytes()==(base/path).read_bytes(),f'{path}: concurrent work unchanged')
# The header is intentionally in scope: verify its replacement configuration instead.
strip=html.fromstring((root/'market-strip.html').read_text())
loader='https://s3.tradingview.com/external-embedding/embed-widget-ticker-tape.js'
scripts=strip.xpath('//script[@src=$src]',src=loader)
check(len(scripts)==1,'one official scrolling ticker loader')
ticker=json.loads(scripts[0].text)
old_strip=html.fromstring((base/'market-strip.html').read_text()).xpath('//*[self::tv-tickers or self::tv-ticker-tape]')[0]
old_symbols=old_strip.get('symbols').split(',')
old_titles=json.loads(old_strip.get('symbol-titles'))
check(ticker['symbols']==[{'proName':symbol,'title':old_titles[symbol]} for symbol in old_symbols],'ticker symbols and Chinese names preserved')
check(ticker.get('displayMode')=='regular','ticker uses regular height on all viewport sizes')
check(ticker.get('largeChartUrl')=='https://sking-3.github.io/xuanliu-site/chart.html','ticker links remain in site')
check(ticker.get('locale')=='zh_CN' and ticker.get('showSymbolLogo') is False,'ticker language and symbol-logo settings preserved')
check('--books-ticker-height:45px' in re.sub(r'\s+','',(root/'index-ticker.css').read_text()),'compact header starts at 45px')
check('zoom:.75' in re.sub(r'\s+','',(root/'market-strip.css').read_text()),'entire ticker scales uniformly')
check(len(strip.xpath('//body/div[@data-books-attribution][@hidden]'))==1,'strip attribution stays hidden outside provider container')
for path in ['market-feed.css','chart.css','market-strip.css']:
 check('[data-books-attribution][hidden]{display:none!important}' in re.sub(r'\s+','',(root/path).read_text()),f'{path}: hidden attribution uses scoped no-layout rule')
for p in pages:
 tree=html.fromstring(p.read_text())
 for node in tree.xpath('//*[@href or @src]'):
  ref=node.get('href') or node.get('src');u=urlsplit(ref);version=parse_qs(u.query).get('v',[''])[0]
  if u.scheme or u.netloc or not re.fullmatch(r'[0-9a-f]{8}',version):continue
  target=(p.parent/unquote(u.path)).resolve()
  check(hashlib.sha256(target.read_bytes()).hexdigest()[:8]==version,f'{p}: content version matches {ref}')
print(f'PASS {checks} static assertions across {len(pages)} HTML documents (11 full pages + shared strip).')
