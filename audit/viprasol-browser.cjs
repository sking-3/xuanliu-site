'use strict';
// UI acceptance only: real site archive, no indicator formulas evaluated by this test.
// Run in the existing release Chromium/WebKit job; do not launch a local browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require('playwright');
const root = path.resolve(__dirname, '..');
const base = new URL(process.env.RELEASE_BASE_URL);
const engine = process.env.RELEASE_BROWSER || 'chromium';
const output = path.join(process.env.RELEASE_OUTPUT || path.join(__dirname, 'browser-output/release'), engine);
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const snapshot = read('quant-research/data/latest.json');
const market = read('quant-research/viprasol-market.json');
const catalog = read('quant-research/viprasol-catalog.json').items;
const older = structuredClone(snapshot);
older.bars.pop();
older.latestClosedAt = new Date(older.bars.at(-1).time + 86400000).toISOString();
older.retrievedAt = new Date(Date.parse(snapshot.retrievedAt) - 86400000).toISOString();
const snapshotPath = new URL('quant-research/data/latest.json', base).pathname;
const marketPath = new URL('quant-research/viprasol-market.json', base).pathname;
const isoDay = time => new Date(time).toISOString().slice(0, 10);
const archivedDays = new Set(snapshot.bars.map(bar => isoDay(bar.time)));
const report = {
  engine, base: base.href, fixture: 'quant-research/data/latest.json', synthetic: false,
  source: {name: snapshot.source.name, symbol: snapshot.source.symbol, bars: snapshot.bars.length,
    latestClosedAt: snapshot.latestClosedAt, retrievedAt: snapshot.retrievedAt},
  externalRequestsBlocked: true, writesBlocked: true, blockedExternalRequests: 0,
  writeAttempts: [], viewports: [], failures: []
};

async function settled(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}
async function loaded(page) {
  await page.waitForFunction(() => {
    const states = [...document.querySelectorAll('#indicator-library .indicator-state')];
    return states.length === 29 && states.every(node => !node.textContent.includes('等待核验'))
      && !document.querySelector('#indicator-refresh').disabled;
  }, null, {timeout: 45000});
  assert.equal(await page.locator('#indicator-run').isEnabled(), true, 'archive enables computation');
  await settled(page);
}
async function choose(page, id) {
  await page.locator('#indicator-select').selectOption(id);
  const definition = catalog.find(item => item.id === id);
  assert.equal(await page.locator('#indicator-result h3').textContent(), definition.title, id + ' selected title');
}
async function priceDates(page) {
  return page.locator('.indicator-chart svg text').evaluateAll(nodes => nodes.map(node => node.textContent)
    .filter(text => /^\d{4}-\d{2}-\d{2}$/.test(text)));
}
async function chartGeometry(page) {
  return page.locator('.indicator-chart svg').evaluate(svg => {
    const fontSizes = [...svg.querySelectorAll('text')].map(text => {
      const matrix = text.getScreenCTM();
      return parseFloat(getComputedStyle(text).fontSize) * Math.min(Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d));
    });
    return {viewBoxWidth: svg.viewBox.baseVal.width, renderedWidth: svg.getBoundingClientRect().width,
      minimumTextPixels: Math.min(...fontSizes)};
  });
}
async function visibleArchive(page) {
  return {
    provenance: await page.locator('#indicator-provenance').textContent(),
    result: await page.locator('#indicator-result').textContent(),
    dates: await priceDates(page),
    selected: await page.locator('#indicator-select').inputValue(),
    window: await page.locator('#indicator-window').inputValue()
  };
}
async function refresh(page) {
  await page.locator('#indicator-refresh').click();
  await loaded(page);
}
async function assertRetained(page, previous, reason) {
  assert.match(await page.locator('#indicator-status').textContent(), /保留上次真实数据/, reason + ' retention status');
  assert.deepEqual(await visibleArchive(page), previous, reason + ' values, source time, parameters and chart retained');
}
async function viewportCheck(browser, width) {
  const result = {width, indicators: [], interactions: [], snapshotReads: 0, marketReads: 0, uncaughtErrors: []};
  report.viewports.push(result);
  const context = await browser.newContext({viewport: {width, height: 960}, serviceWorkers: 'block', reducedMotion: 'reduce'});
  let fixtureMode = 'normal';
  await context.routeWebSocket('**/*', socket => socket.close());
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (!['GET', 'HEAD'].includes(request.method())) {
      report.writeAttempts.push({path: url.pathname, method: request.method()});
      return route.abort();
    }
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
      report.blockedExternalRequests++;
      return route.abort();
    }
    if (url.pathname === snapshotPath) {
      result.snapshotReads++;
      if (fixtureMode === 'failed') return route.fulfill({status: 503, json: {error: 'read_only_archive_failure'}});
      return route.fulfill({status: 200, json: fixtureMode === 'older' ? older : snapshot});
    }
    if (url.pathname === marketPath) {
      result.marketReads++;
      return route.fulfill(fixtureMode === 'missing-market'
        ? {status: 503, json: {error: 'read_only_market_failure'}} : {status: 200, json: market});
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => result.uncaughtErrors.push(error.message));
  try {
    const response = await page.goto(new URL('quant-research/indicators.html', base).href, {waitUntil: 'domcontentloaded'});
    assert.equal(response.status(), 200, 'indicator page HTTP');
    await loaded(page);
    const options = await page.locator('#indicator-select option').evaluateAll(nodes => nodes.map(node => ({id: node.value, title: node.textContent})));
    assert.equal(options.length, 29, 'all 29 native ports selectable');
    assert.deepEqual(options, catalog.map(({id, title}) => ({id, title})), 'UI is tied to the archived source catalog');
    const timeText = await page.evaluate(({closed, captured}) => [closed, captured].map(value =>
      new Date(value).toLocaleString('zh-CN', {hour12: false, timeZone: 'Asia/Shanghai'}) + '（北京）'),
    {closed: snapshot.latestClosedAt, captured: snapshot.retrievedAt});
    const provenance = await page.locator('#indicator-provenance').textContent();
    assert.ok(provenance.includes(snapshot.source.name), 'real source attribution');
    for (const stamp of timeText) assert.ok(provenance.includes(stamp), 'source and acquisition times remain distinct');
    assert.match(await page.locator('#indicator-status').textContent(), new RegExp(snapshot.bars.length + '根'));
    assert.match(await page.locator('#indicator-market').textContent(), /Kraken AssetPairs/);
    let blocked = 0;
    for (const definition of catalog) {
      await choose(page, definition.id);
      const state = await page.locator('.indicator-result-head p').first().textContent();
      assert.doesNotMatch(state, /计算未完成|等待核验/, definition.id + ' default parameters must not error');
      const source = page.locator('#indicator-library [data-choose-indicator="' + definition.id + '"]').locator('..').locator('..');
      assert.equal(await source.locator('.indicator-state').textContent(), state, definition.id + ' library state matches selection');
      assert.equal(await source.locator('a').getAttribute('href'), 'viprasol-source/' + definition.sourceFile, definition.id + ' retained source link');
      const signals = await page.locator('#indicator-result .indicator-table tbody tr').count();
      const dates = await page.locator('#indicator-result .indicator-table tbody tr td:first-child').allTextContents();
      assert.ok(dates.every(day => archivedDays.has(day)), definition.id + ' rendered event times belong to the real archive');
      assert.ok(signals <= 30, definition.id + ' recent signal table stays bounded');
      if (state.includes('当前停用')) {
        blocked++;
        assert.equal(signals, 0, definition.id + ' missing dependencies generate no signal rows');
        assert.equal(await page.locator('#indicator-result svg').count(), 0, definition.id + ' missing dependencies generate no chart annotations');
        assert.match(await page.locator('#indicator-result').textContent(), /缺少依赖时不生成信号/);
      } else assert.match(state, /当前数据可计算/, definition.id + ' explicit enabled state');
      result.indicators.push({id: definition.id, state, renderedSignals: signals});
    }
    assert.ok(blocked > 0, 'unavailable additional series remain visibly disabled');

    await choose(page, 'goal-setting-strategies');
    await page.locator('details.indicator-parameters summary').click();
    await page.locator('[data-param-key="vip_total_goals"]').fill('5');
    await page.getByRole('textbox', {name: '目标1内容', exact: true}).fill('Read-only acceptance goal');
    await page.getByRole('checkbox', {name: '目标1已完成', exact: true}).check();
    await page.locator('#indicator-run').click();
    assert.match(await page.locator('#indicator-result .indicator-caption strong').textContent(), /1\/5.*20%/);
    assert.match(await page.locator('#indicator-result').textContent(), /✓ Read-only acceptance goal/);
    assert.equal(await page.locator('#indicator-result svg, #indicator-result .indicator-table').count(), 0, 'goals do not become price or trade signals');
    result.interactions.push({test: 'goal edit and checkbox', complete: 1, total: 5});

    for (const id of ['wave-structure-pro-v2', 'z-score-stats']) {
      await choose(page, id);
      const labels = await page.locator('.indicator-chart svg text').allTextContents();
      assert.ok(!labels.some(label => label === 'B' || label === 'S'), id + ' structural markers are not buys/sells');
      result.interactions.push({test: 'structure markers', id, renderedSignals: await page.locator('#indicator-result .indicator-table tbody tr').count()});
    }

    await page.locator('#indicator-library [data-choose-indicator="tyson"]').click();
    assert.equal(await page.locator('#indicator-select').inputValue(), 'tyson', 'library selects the current workspace');
    for (const window of ['60', '120', 'all']) {
      await page.locator('#indicator-window').selectOption(window);
      await settled(page);
      const geometry = await chartGeometry(page);
      const start = window === 'all' ? 0 : Math.max(0, snapshot.bars.length - Number(window));
      const middle = Math.floor((start + snapshot.bars.length - 1) / 2);
      const indices = geometry.viewBoxWidth < 600 ? [start, snapshot.bars.length - 1] : [start, middle, snapshot.bars.length - 1];
      const expected = indices.map(index => isoDay(snapshot.bars[index].time));
      assert.deepEqual(await priceDates(page), expected, window + ' visible chart follows the selected archived window');
      if (width === 390) assert.ok(geometry.minimumTextPixels >= 9 || geometry.viewBoxWidth <= geometry.renderedWidth + 10,
        window + ' mobile chart labels must not shrink to unreadable desktop-size coordinates: ' + JSON.stringify(geometry));
      result.interactions.push({test: 'chart window', window, firstDay: expected[0], lastDay: expected.at(-1), dateLabels: expected.length, ...geometry});
    }
    const parameter = page.locator('[data-param-key="compLen"]');
    await parameter.fill('');
    await page.locator('#indicator-run').click();
    assert.match(await page.locator('.indicator-result-head p').first().textContent(), /计算未完成：无效参数：compLen/);
    assert.equal(await page.locator('#indicator-result svg, #indicator-result .indicator-table').count(), 0, 'invalid parameters leave no misleading old signals');
    result.interactions.push({test: 'invalid parameter', parameter: 'compLen', clearError: true});
    await choose(page, 'tyson');
    await page.locator('#indicator-window').selectOption('60');
    const previous = await visibleArchive(page);
    fixtureMode = 'failed';
    await refresh(page);
    await assertRetained(page, previous, 'failed archive read');
    assert.match(await page.locator('#indicator-status').textContent(), /读取失败（503）/);
    fixtureMode = 'older';
    await refresh(page);
    await assertRetained(page, previous, 'older real archive prefix');
    assert.match(await page.locator('#indicator-status').textContent(), /拒绝用更旧的数据替换当前归档/);
    result.interactions.push({test: 'failed and older reads retain archive', olderFixture: 'same real bars, last day removed', retainedBars: snapshot.bars.length});

    fixtureMode = 'missing-market';
    const previousMarket = await page.locator('#indicator-market').textContent();
    await refresh(page);
    await choose(page, 'absorption-radar-pro');
    assert.match(await page.locator('.indicator-result-head p').first().textContent(), /当前数据可计算/);
    const retainedMarket = await page.locator('#indicator-market').textContent();
    assert.match(retainedMarket, /本次规格读取失败，保留上次有效规格/);
    assert.ok(retainedMarket.endsWith(previousMarket), 'failed specification refresh keeps the exact previous specification and source time');
    const emptyMarketPage = await context.newPage();
    emptyMarketPage.setDefaultTimeout(15000);
    emptyMarketPage.on('pageerror', error => result.uncaughtErrors.push(error.message));
    try {
      await emptyMarketPage.goto(new URL('quant-research/indicators.html', base).href, {waitUntil: 'domcontentloaded'});
      await loaded(emptyMarketPage);
      await choose(emptyMarketPage, 'absorption-radar-pro');
      assert.match(await emptyMarketPage.locator('.indicator-result-head p').first().textContent(), /当前停用.*official_mintick/);
      assert.equal(await emptyMarketPage.locator('#indicator-result svg, #indicator-result .indicator-table').count(), 0, 'first load without official tick size produces no signals');
      assert.match(await emptyMarketPage.locator('#indicator-market').textContent(), /规格未取得/);
      fixtureMode = 'normal';
      await refresh(emptyMarketPage);
      assert.match(await emptyMarketPage.locator('.indicator-result-head p').first().textContent(), /当前数据可计算/);
    } finally {
      await emptyMarketPage.close();
    }
    result.interactions.push({test: 'official tick size failure and recovery', previousSpecificationRetained: true, emptyInitialSpecificationDisabled: true});
    fixtureMode = 'normal';
    await refresh(page);
    assert.match(await page.locator('.indicator-result-head p').first().textContent(), /当前数据可计算/);
    assert.match(await page.locator('#indicator-market').textContent(), /Kraken AssetPairs/);
    await settled(page);
    const layout = await page.evaluate(() => ({viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth}));
    assert.ok(layout.scrollWidth <= layout.viewport + 1, 'page fits the ' + width + 'px viewport');
    assert.deepEqual(result.uncaughtErrors, [], 'no uncaught browser errors');
    result.layout = layout;
  } catch (error) {
    report.failures.push({width, error: error.message, uncaughtErrors: result.uncaughtErrors});
    await page.screenshot({path: path.join(output, 'viprasol-failure-' + width + '.png')}).catch(() => {});
  } finally {
    await context.close();
  }
}

async function main() {
  assert.ok(['chromium', 'webkit'].includes(engine), 'supported release browser');
  assert.equal(catalog.length, 29, 'fixed source catalog contains 29 indicators');
  assert.ok(snapshot.bars.length >= 120, 'real archive supports the requested windows');
  assert.equal(snapshot.source.symbol, 'BTC/USD');
  fs.mkdirSync(output, {recursive: true});
  const browser = await playwright[engine].launch(engine === 'chromium' && process.env.RELEASE_BROWSER_EXECUTABLE
    ? {executablePath: process.env.RELEASE_BROWSER_EXECUTABLE} : {});
  try {
    for (const width of [1440, 390]) await viewportCheck(browser, width);
    assert.deepEqual(report.writeAttempts, [], 'no write request initiated');
    assert.deepEqual(report.failures, [], 'all indicator browser interactions pass');
    console.log('PASS ' + engine + ': 29 indicators at desktop/mobile widths, parameters, provenance and archive retention; all external/write traffic blocked');
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(output, 'viprasol.json'), JSON.stringify(report) + '\n');
  }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
