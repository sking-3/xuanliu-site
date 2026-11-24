'use strict';
// Layout and read-only interaction smoke tests. No third-party or write request leaves this test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require('playwright');
const root = path.resolve(__dirname, '..');
const base = new URL(process.env.RELEASE_BASE_URL);
const engine = process.env.RELEASE_BROWSER || 'chromium';
const output = path.join(process.env.RELEASE_OUTPUT || path.join(__dirname, 'browser-output/release'), engine);
const excluded = new Set(['.git', '_source', 'node_modules', 'audit', 'work', 'private-follow']);
const special = new Set(['a-market-widget.html', 'home-watch-quotes.html', 'market-strip.html', 'trader/binance/index.html']);
function pages(directory = root) {
  return fs.readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return excluded.has(entry.name) ? [] : pages(file);
    return entry.name.endsWith('.html') ? [path.relative(root, file).split(path.sep).join('/')] : [];
  }).sort();
}
const routes = pages();
const report = {engine, base: base.href, synthetic: true, externalRequestsBlocked: true, writesBlocked: true,
  pages: [], interactions: [], failures: [], writeAttempts: [], blockedExternalRequests: 0};
const accountUser = {id: 'offline-smoke-user', accountNo: '001', displayName: '离线界面验收',
  email: 'offline-smoke@example.invalid', role: 'user', status: 'active', createdAt: '2026-11-01T00:00:00Z'};

async function settled(page) {
  await page.evaluate(async () => {await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(resolve));});
}
async function readerCheck(page, route, width) {
  const toggle = page.locator('#academy-toc-toggle');
  assert.equal(await toggle.count(), 1, route + ' chapter toggle');
  assert.equal(await page.locator('#academy-toc-dialog').count(), 1, route + ' mobile chapter dialog');
  const directory = page.locator('.sidebar:not(.books-sidebar)');
  assert.equal(await directory.count(), 1, route + ' original chapter directory retained');
  assert.ok(await directory.locator('a[href^="#"], [data-tid]').count() > 0, route + ' chapter navigation retained');
  if (width < 1101) {
    assert.equal(await directory.evaluate(node => node.parentElement.id), 'academy-toc-dialog', route + ' narrow directory placement');
  } else {
    assert.ok(await directory.evaluate(node => node.parentElement.matches('.layout-container,.layout')), route + ' desktop directory placement');
  }
  if (route !== 'academy/laoemo/index.html') return;
  for (const id of ['btnWebMode', 'btnPdfMode']) {
    assert.equal(await directory.locator('#' + id).count(), 1, 'book mode stays with chapter directory: ' + id);
  }
  assert.equal(await page.locator('#btnWebMode').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#btnPdfMode').getAttribute('aria-selected'), 'false');
  assert.equal(await page.locator('#pdfFrame').getAttribute('src'), null, 'PDF remains lazy until selected');
  if (width < 1101) {
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#academy-toc-dialog').evaluate(node => node.open), true);
  }
  const chapter = directory.locator('a[href="#sec-2"]');
  await chapter.click();
  await settled(page);
  assert.equal(new URL(page.url()).hash, '#sec-2', 'book chapter switches to the existing target');
  if (width < 1101) {
    assert.equal(await page.locator('#academy-toc-dialog').evaluate(node => node.open), false);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  }
  report.interactions.push({route, width, test: 'original book modes and chapter navigation, no PDF download or writes'});
}

async function main() {
  assert.ok(['chromium', 'webkit'].includes(engine), 'supported browser');
  assert.equal(routes.length, 42, 'all existing pages, the control console and the new indicator workspace are included');
  fs.mkdirSync(output, {recursive: true});
  const browser = await playwright[engine].launch(engine === 'chromium' && process.env.RELEASE_BROWSER_EXECUTABLE
    ? {executablePath: process.env.RELEASE_BROWSER_EXECUTABLE} : {});
  try {
    for (const width of [1440, 390]) {
      const context = await browser.newContext({viewport: {width, height: 960}, serviceWorkers: 'block', reducedMotion: 'reduce'});
      const pageRoutes = new WeakMap();
      await context.routeWebSocket('**/*', socket => socket.close());
      await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        const local = url.origin === base.origin && url.pathname.startsWith(base.pathname);
        const authAPI = [base.origin, 'https://45-77-39-98.sslip.io'].includes(url.origin) && url.pathname.startsWith('/api/');
        if ((local || authAPI) && !['GET', 'HEAD'].includes(request.method())) {
          report.writeAttempts.push({url: url.pathname, method: request.method()});
          return route.abort();
        }
        if(local && url.pathname.endsWith('/books-auth-config.js'))return route.fulfill({status:200,contentType:'text/javascript',body:'window.BOOKS_API_BASE='+JSON.stringify(base.origin)+';'});
        if (authAPI) {
          const owner = pageRoutes.get(request.frame().page());
          const json = (value, status = 200) => route.fulfill({status, json: value,
            headers: {'access-control-allow-origin': base.origin, 'access-control-allow-credentials': 'true'}});
          if (url.pathname === '/api/auth/me') return json(owner === 'account.html'
            ? {authenticated: true, user: accountUser} : {authenticated: false});
          if (url.pathname === '/api/auth/providers') return json({providers: [
            {id: 'email_password', name: '邮箱和密码', enabled: true}, {id: 'google', name: 'Google', enabled: false}]});
          if (url.pathname === '/api/wallet') return json({balances: [], paymentConfigured: false});
          if (url.pathname === '/api/wallet/recharges') return json({orders: []});
          return json({error: 'offline_read_only_smoke', available: false}, 503);
        }
        if (local) return route.continue();
        report.blockedExternalRequests++;
        return route.abort();
      });
      for (const route of routes) {
        const page = await context.newPage(), errors = [];
        pageRoutes.set(page, route);
        page.setDefaultTimeout(10000);
        page.on('pageerror', error => errors.push(error.message));
        try {
          const response = await page.goto(new URL(route, base).href, {waitUntil: 'domcontentloaded'});
          assert.equal(response.status(), 200, route + ' HTTP');
          if (route === 'control/index.html') await page.locator('#auth-gate').waitFor({state: 'visible'});
          if (route === 'account.html') await page.locator('#profile-name').filter({hasText: accountUser.displayName}).waitFor();
          if (route === 'trader/binance/index.html') await page.waitForURL(url => url.pathname.endsWith('/trader/index.html'));
          await settled(page);
          const facts = await page.evaluate(() => ({
            title: document.title,
            bodyText: document.body.innerText.trim().length,
            customContent: document.querySelector('tv-screener')?.getBoundingClientRect().width || 0,
            viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
            hiddenLeaks: [...document.querySelectorAll('[hidden]')].filter(node => getComputedStyle(node).display !== 'none').map(node => node.id || node.tagName),
            styles: [...document.querySelectorAll('link[rel=stylesheet]')].filter(node => new URL(node.href).origin === location.origin)
              .map(node => ({href: node.getAttribute('href'), loaded: Boolean(node.sheet)})),
            sourceLinks: [...document.querySelectorAll('a[href^="https://"]')].length,
            timeElements: document.querySelectorAll('time, [data-source-time], [data-as-of], .sentiment-meta, .entry-opportunities-source, .card-data-status').length,
            inlineStyles: document.querySelectorAll('style').length
          }));
          assert.ok(facts.title.trim(), route + ' title retained');
          if (!['chart.html', 'trader/binance/index.html'].includes(route)) {
            const title = fs.readFileSync(path.join(root, route), 'utf8').match(/<title>([\s\S]*?)<\/title>/i)[1];
            assert.equal(facts.title, title.trim(), route + ' original document title retained');
          }
          assert.ok(facts.bodyText > 0 || route === 'a-market-widget.html' && facts.customContent > 0, route + ' content retained');
          assert.ok(facts.scrollWidth <= facts.viewport + 1, route + ' page overflow ' + JSON.stringify(facts));
          assert.deepEqual(facts.hiddenLeaks, [], route + ' hidden content remains hidden');
          assert.ok(facts.styles.every(style => style.loaded), route + ' local stylesheets loaded');
          assert.ok(facts.styles.length + facts.inlineStyles > 0, route + ' actual style surface');
          if (!special.has(route)) assert.ok(await page.locator('h1').count() > 0, route + ' heading retained');
          if (route === 'control/index.html') {
            assert.equal(await page.locator('#control-app').evaluate(node => node.hidden), true);
            assert.equal(await page.locator('#control-app').isVisible(), false);
            assert.match(await page.locator('#control-status').textContent(), /登录/);
            report.interactions.push({route, width, test: 'anonymous console remains gated'});
          }
          if (route === 'account.html') {
            assert.equal(await page.locator('#profile-email').textContent(), accountUser.email);
            assert.match(await page.locator('#balances').textContent(), /暂无余额/);
            assert.match(await page.locator('#recharge-rows').textContent(), /暂无充值记录/);
            assert.equal(await page.locator('#avatar-modal').getAttribute('aria-hidden'), 'true');
            report.interactions.push({route, width, test: 'synthetic read-only profile, empty wallet and closed modal'});
          }
          if (route.startsWith('academy/')) assert.ok(facts.sourceLinks > 0, route + ' original source links retained');
          if (route.startsWith('academy/') && route !== 'academy/index.html') await readerCheck(page, route, width);
          assert.deepEqual(errors, [], route + ' uncaught errors');
          report.pages.push({route, width, ...facts, uncaughtErrors: errors});
        } catch (error) {
          report.failures.push({route, width, error: error.message, uncaughtErrors: errors});
          await page.screenshot({path: path.join(output, 'site-wide-failure-' + route.replace(/\W+/g, '-') + '-' + width + '.png')}).catch(() => {});
        } finally {
          await page.close();
        }
      }
      await context.close();
    }
    assert.deepEqual(report.writeAttempts, [], 'smoke never initiates a write API');
    assert.deepEqual(report.failures, [], 'all site-wide pages pass');
    console.log('PASS ' + engine + ': ' + report.pages.length + ' site-wide page/viewport checks, ' + report.interactions.length + ' read-only interactions; third-party HTTP/WebSocket traffic blocked');
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(output, 'site-wide.json'), JSON.stringify(report, null, 2) + '\n');
  }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
