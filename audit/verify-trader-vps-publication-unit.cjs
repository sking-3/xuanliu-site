'use strict';

const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');

const source = path.join(__dirname, '../scripts/verify-trader-vps-publication.sh');
const catalogues = [
  'trader/feed.json',
  'trader/analytics.json',
  'trader/portfolios.json',
  'trader/okx/trades.json',
  'trader/okx/period-returns.json',
  'trader/bitget/period-returns.json',
];
const periodFile='trader/period-samples.json';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-vps-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const git = (...args) => {
    const result = spawnSync('git', args, {cwd: root, encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '--quiet');
  for (const file of [...catalogues,periodFile]) {
    const fullPath = path.join(root, file);
    fs.mkdirSync(path.dirname(fullPath), {recursive: true});
    fs.writeFileSync(fullPath, JSON.stringify({file, sample: 'x'.repeat(65535)}) + '\n');
  }
  git('add', 'trader');
  git('-c', 'user.name=Audit Fixture', '-c', 'user.email=audit@example.invalid', '-c', 'commit.gpgSign=false',
    'commit', '--quiet', '-m', 'Fixture');

  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(source, path.join(root, 'scripts/verify-trader-vps-publication.sh'));
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin/curl'), `#!/usr/bin/env bash
set -eu
[[ $1 == --disable ]]
url=${"${@: -1}"}
case "$url" in
  https://45-77-39-98.sslip.io/trader/*'?verify='*) ;;
  *) echo "Unexpected URL: $url" >&2; exit 1 ;;
esac
prefix=https://45-77-39-98.sslip.io/
file=${"${url#\"$prefix\"}"}
file=${"${file%%\\?*}"}
printf '%s\\n' "$file" >> "$MOCK_LOG"
if [[ $file == "${"${MOCK_FILE-}"}" && ${"${MOCK_MODE-}"} == stale ]]; then
  printf '{"stale":true}200'
  exit
fi
git -C "$MOCK_ROOT" show "HEAD:$file"
if [[ $file == "${"${MOCK_FILE-}"}" ]]; then
  case "${"${MOCK_MODE-}"}" in
    redirect) printf 302; exit ;;
    disconnect) printf 200; exit 18 ;;
  esac
fi
printf 200
`, {mode: 0o700});
  const clock = path.join(root, 'clock.sh');
  fs.writeFileSync(clock, 'sleep() { SECONDS=500; }\n');
  return {
    root,
    run(args = [], mode = '') {
      const log = path.join(root, 'requests.log');
      fs.writeFileSync(log, '');
      const result = spawnSync('bash', ['scripts/verify-trader-vps-publication.sh', ...args], {
        cwd: root,
        encoding: 'utf8',
        timeout: 20000,
        env: {...process.env, PATH: path.join(root, 'bin') + path.delimiter + process.env.PATH,
          BASH_ENV: clock, MOCK_ROOT: root, MOCK_LOG: log, MOCK_FILE: catalogues[0], MOCK_MODE: mode},
      });
      return {...result, requested: fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)};
    },
  };
}

test('formal VPS verification compares all files with the committed bytes, including trailing newlines', t => {
  const {root, run} = fixture(t);
  fs.writeFileSync(path.join(root, catalogues[0]), '{"dirty":true}\n');
  const result = run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(result.requested, catalogues);
  assert.match(result.stdout, /Verified all 6 trader catalogs/);
});

test('exchange recovery verifies only the three exchange catalogues', t => {
  const result = fixture(t).run(['--exchange-only']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(result.requested, catalogues.slice(3));
});

test('period-bundle verification binds the current directory and its period samples only', t => {
  const result=fixture(t).run(['--period-bundle']);
  assert.equal(result.status,0,result.stderr+result.stdout);
  assert.deepEqual(result.requested,['trader/feed.json',periodFile]);
});

test('mismatches, redirects and interrupted body transfers never pass the release gate', t => {
  const {run} = fixture(t);
  for (const [mode, message] of [['stale', /SHA-256 mismatch/], ['redirect', /HTTP 302/],
    ['disconnect', /failed to read HTTPS response/]]) {
    const result = run([], mode);
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.deepEqual(result.requested, catalogues);
    assert.match(result.stdout, message);
    assert.match(result.stderr, /did not match the committed catalogs/);
  }
});
