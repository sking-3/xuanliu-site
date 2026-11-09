"""Local resource, document semantics and truthful-preview regression checks."""
from pathlib import Path
from lxml import html
from urllib.parse import urlsplit, unquote, parse_qs
import hashlib,json,re,math
from datetime import datetime
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
check(feed.get('schemaVersion')==1 and feed.get('status') in ('ready','unavailable'), 'public feed declares readiness or a truthful failure')
rows=feed.get('traders',[]); source=feed.get('source',{})
check(isinstance(rows,list) and 0<=len(rows)<=200 and len((root/'trader/feed.json').read_bytes())<2097152, 'bounded public-account snapshot permits verified empty results')
check(source.get('id')=='hyperliquid' and source.get('selectedAccounts')==len(rows), 'public source and selected-account count match')
check(type(source.get('totalAccounts')) is int and source['totalAccounts']>=len(rows), 'selected subset does not claim complete coverage')
check(source.get('refreshIntervalMinutes')==30 and source.get('staleAfterMinutes')==120, 'collection cadence and freshness threshold explicitly declared')
verification=source.get('positionVerification')
if feed['status']=='ready':
 check(source.get('status') in ('ok','stale'), 'snapshot failure state declared')
 check(bool(re.fullmatch('[0-9a-f]{64}',source.get('rawSha256',''))), 'source-response digest retained without publishing the raw payload')
 for key in ('fetchedAt','lastAttemptAt'):
  check(isinstance(source.get(key),str) and datetime.fromisoformat(source[key].replace('Z','+00:00')).tzinfo is not None, 'source timestamps include timezone: '+key)
 if source.get('snapshotAt') is not None:
  check(datetime.fromisoformat(source['snapshotAt'].replace('Z','+00:00'))<=datetime.fromisoformat(source['fetchedAt'].replace('Z','+00:00')), 'snapshot generation does not postdate collection')
else:
 check(rows==[] and source.get('status')=='error' and source.get('fetchedAt') is None, 'failed initial collection does not invent a successful snapshot')
 check(bool(source.get('errorCode')) and bool(source.get('lastAttemptAt')), 'unavailable source records failure and attempt time')
if verification is not None:
 check(verification.get('scope')=='default_perp_dex' and verification.get('maxAgeMinutes')==60, 'holding qualification declares exact market scope and one-hour lifetime')
 for key in ('candidateAccounts','checkedAccounts','holdingAccounts','emptyAccounts','failedAccounts','unattemptedAccounts'):
  check(type(verification.get(key)) is int and 0<=verification[key]<=200, 'bounded qualification count: '+key)
 check(verification['candidateAccounts']==verification['checkedAccounts']+verification['failedAccounts']+verification['unattemptedAccounts'], 'all candidates are accounted for once')
 check(verification['checkedAccounts']==verification['holdingAccounts']+verification['emptyAccounts'] and verification['holdingAccounts']==len(rows), 'readable empty accounts are separate from failures and omitted from published rows')
 completed=datetime.fromisoformat(verification['completedAt'].replace('Z','+00:00'))
 check(datetime.fromisoformat(source['fetchedAt'].replace('Z','+00:00'))<=completed<=datetime.fromisoformat(source['lastAttemptAt'].replace('Z','+00:00')), 'position verification time is separate from leaderboard collection')
else:
 check(all('positionCheck' not in row for row in rows), 'legacy unqualified input cannot contain unverified mixed qualification')
seen=set()
for row in rows:
 address=row.get('accountId','').lower()
 check(bool(re.fullmatch('0x[0-9a-f]{40}',address)) and address not in seen, 'distinct on-chain public account')
 seen.add(address)
 if verification is not None:
  position=row.get('positionCheck',{})
  check(position.get('scope')=='default_perp_dex' and type(position.get('count')) is int and position['count']>0, 'every published qualified account has nonzero verified holdings')
  checked=datetime.fromisoformat(position['checkedAt'].replace('Z','+00:00')); position_source=datetime.fromisoformat(position['sourceTime'].replace('Z','+00:00'))
  check(checked.tzinfo is not None and position_source.tzinfo is not None and checked<=completed, 'holding verification uses timezone-aware source and retrieval timestamps')
  check(-5<=(checked-position_source).total_seconds()<=120, 'only fresh position responses qualify at collection time')
 check(row.get('sourceKind')=='public_account' and row.get('exchange')=='Hyperliquid' and row.get('currency')=='USD' and not row.get('featured') and not row.get('paid'), 'source currency and public scope retained')
 check(row.get('sourceUrl')=='https://app.hyperliquid.xyz/explorer/address/'+address, 'account links point to the exact official address')
 check(set(row.get('windows',{}))=={'7D','30D','ALL'}, 'only source-supported windows are published')
 for period,native in [('7D','week'),('30D','month'),('ALL','allTime')]:
  window=row['windows'][period]
  check(window.get('sourcePeriod')==native, 'native performance window is retained')
  check(all(window.get(k) is None for k in ('mdd','wins','closedTrades')) and window.get('curve')==[], 'no inferred drawdown, win rate or fabricated curve')
  check(all(window.get(k) is None or isinstance(window[k],(int,float)) and math.isfinite(window[k]) for k in ('roi','pnl')), 'public metrics are finite or explicitly missing')
 check(all(row.get(k)==[] for k in ('positions','points','orders')), 'unfetched account records stay empty')
# The original payload stays outside the published tree. When present, independently
# compare the complete selected set and every source metric with that actual response.
raw_path=root.parent/'hl_live_20261110/leaderboard-source.json'
if raw_path.is_file() and source.get('rawSha256')==hashlib.sha256(raw_path.read_bytes()).hexdigest():
 raw=json.loads(raw_path.read_text())['leaderboardRows']
 by_address={r['ethAddress'].lower():r for r in raw}
 ranked=sorted(raw,key=lambda r:(-float(dict(r['windowPerformances'])['month']['pnl']),r['ethAddress'].lower()))[:200]
 ranked_addresses={r['ethAddress'].lower() for r in ranked}
 check(set(seen)<=ranked_addresses if verification is not None else set(seen)==ranked_addresses, 'published accounts come from the actual monthly-PnL top candidates, reduced only by qualification')
 for row in rows:
  native=dict(by_address[row['accountId'].lower()]['windowPerformances'])
  for period,key in [('7D','week'),('30D','month'),('ALL','allTime')]:
   for metric,multiplier in [('roi',100),('pnl',1)]:
    check(math.isclose(row['windows'][period][metric],float(native[key][metric])*multiplier,rel_tol=1e-12,abs_tol=1e-9), 'published performance equals source value with correct unit conversion')
trader_page=html.fromstring((root/'trader/index.html').read_text())

# On-demand public account reads are limited to Hyperliquid's documented hosts.
csp=trader_page.xpath('//meta[@http-equiv="Content-Security-Policy"]/@content')[0]
connect=next((part.strip().split()[1:] for part in csp.split(';') if part.strip().startswith('connect-src ')),[])
check(set(connect)=={"'self'",'https://api.hyperliquid.xyz','wss://api.hyperliquid.xyz'}, 'account read CSP permits only same-origin and exact official REST/WS hosts')
live_scripts=trader_page.xpath('//script[starts-with(@src,"account-live.js")]')
check(len(live_scripts)==1 and 'defer' in live_scripts[0].attrib, 'public live-data module loaded exactly once without blocking page')
live_ref=live_scripts[0].get('src')
check(bool(re.fullmatch('[0-9a-f]{8}',parse_qs(urlsplit(live_ref).query).get('v',[''])[0])), 'live-data module has a content hash version')
script_sources=trader_page.xpath('//script[@src]/@src')
check(script_sources.index(live_ref)<next(i for i,ref in enumerate(script_sources) if ref.startswith('plaza.js')), 'public live client initializes before detail UI')
analytics_scripts=trader_page.xpath('//script[starts-with(@src,"account-analytics.js")]')
check(len(analytics_scripts)==1 and 'defer' in analytics_scripts[0].attrib, 'public analytics module loaded exactly once without blocking page')
analytics_ref=analytics_scripts[0].get('src')
check(bool(re.fullmatch('[0-9a-f]{8}',parse_qs(urlsplit(analytics_ref).query).get('v',[''])[0])), 'analytics module has a content hash version')
check(script_sources.index(analytics_ref)<next(i for i,ref in enumerate(script_sources) if ref.startswith('plaza.js')), 'analytics client initializes before card UI')
plaza_source=(root/'trader/plaza.js').read_text()
check("state.publicRows.filter(r=>qualifiedPosition(r))" in plaza_source and "!state.source?.positionVerification||!check" in plaza_source, 'legacy unqualified public snapshots are gated from visible rows')
check('now-checked<=3600000' in plaza_source and 'setInterval(()=>{reevaluatePositions();' in plaza_source, 'qualification expires independently of the collection workflow')
check("startVisibleAnalytics(visibleRows)" in plaza_source and 'client?.setPortfolioTargets(accounts)' in plaza_source, 'automatic portfolio reads are scoped to visible accounts')
check("'来源采样回撤'" in plaza_source and "'平仓成交胜率'" in plaza_source, 'calculated metrics distinguish sampled drawdown and closing-fill rate')
check("record?.win?.status==='ready'" in plaza_source and "'metric-load'" in plaza_source, 'closing-fill rate uses its own fetched result and an explicit load control')
check("'performance-body'" in plaza_source and "'performance-chart'" in plaza_source and 'compactMoney(w?.pnl,currency)' in plaza_source, 'card separates compact numeric metrics and the source curve')
check("chart({curve:w.points},'pnl')" in plaza_source, 'public sparkline uses fetched portfolio points rather than a placeholder curve')
check((root/'audit/account-analytics-unit.cjs').is_file(), 'analytics edge cases have dedicated offline regression coverage')
check(len(trader_page.xpath('//*[@id="tabs"]//button[@data-tab="live"][@hidden]'))==1, 'live tab is initially hidden until an eligible public account is selected')
check(not trader_page.xpath('//input[@type="password"]'), 'public account reads do not introduce credential collection')

check(not trader_page.xpath('//*[@id="import-trigger" or @id="export-records" or @id="import-file"]'), 'trader file import/export controls removed')
check(not trader_page.xpath('//script[contains(@src,"okx-import.js")]'), 'trader page does not load the offline file adapter')
check('导入' not in trader_page.text_content() and '导出' not in trader_page.text_content(), 'trader page contains no removed import/export instructions')
check('本页无外部请求' not in (root/'screening/history.html').read_text(),'External source disclosure correct')
check('"showChart":false' in (root/'index.html').read_text(),'Home compact market cards preserved')
# Preserve the latest concurrent navigation/trader work, without requiring a Git checkout.
base=root.parent/'attribution_base_20261110'
for path in ['books-shell.js','books-ui.css','index-ticker.js']:
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
