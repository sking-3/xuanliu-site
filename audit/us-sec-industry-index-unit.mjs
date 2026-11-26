import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {loadSecIndustryIndex, secIndustryQuarter} from '../server/us-sec-industry-index.mjs';

test('SEC quarter eligible after the publication lag, including exact and year boundaries', () => {
  assert.equal(secIndustryQuarter('2026-11-13').quarter, '2026q2');
  assert.equal(secIndustryQuarter('2026-11-14').quarter, '2026q3');
  assert.equal(secIndustryQuarter('2027-02-14T21:00:00.000Z').quarter, '2026q4');
  assert.throws(() => secIndustryQuarter('2026-02-30'), /有效的收盘日期/);
});

test('SEC archive keeps only the interpreted filing index and reuses it under original provenance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'books-sec-index-test-'));
  try {
    const fixture = ['adsh\tcik\tname\tsic\tform\tperiod\tfiled\taccepted',
      '0001633917-26-000111\t1633917\tFixture Issuer\t7389\t10-Q\t20260630\t20260930\t2026-09-30 16:00:00.0',
      '0001633917-26-000112\t1633917\tFixture Issuer\t7372\t10-Q/A\t20260630\t20261001\t2026-10-01 16:00:00.0', ''].join('\n');
    await writeFile(join(directory, 'sub.txt'), fixture);
    execFileSync('zip', ['-q', 'fixture.zip', 'sub.txt'], {cwd:directory});
    const bytes = await readFile(join(directory, 'fixture.zip'));
    let requestCount = 0;
    const get = async url => {
      requestCount++;
      assert.equal(url, 'https://www.sec.gov/files/dera/data/financial-statement-data-sets/2026q3.zip');
      return bytes;
    };
    const readAt = '2026-11-26T12:00:00Z';
    const options = {directory, asOf:'2026-11-25', readAt, get};
    const result = await loadSecIndustryIndex(options);
    assert.equal(result.byCik.get('0001633917').sic, '7389');
    assert.equal(result.asOf, '2026-09-30');
    assert.deepEqual((await readdir(directory)).sort(), ['fixture.zip', 'sec-industry-2026q3.json.gz', 'sub.txt']);
    const next = await loadSecIndustryIndex({...options, asOf:'2026-11-27', readAt:'2026-11-28T12:00:00Z'});
    assert.equal(requestCount, 1);
    assert.equal(next.readAt, readAt);
    assert.deepEqual(next.byCik, result.byCik);
  } finally {
    await rm(directory, {recursive:true, force:true});
  }
});

test('SEC denial makes no alternate request and creates no usable index', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'books-sec-index-denied-'));
  try {
    const attempts = [];
    const get = async url => {attempts.push(url); throw Error('来源已停止 HTTP 403');};
    await assert.rejects(loadSecIndustryIndex({directory, asOf:'2026-11-25', readAt:'2026-11-26T12:00:00Z', get}), /HTTP 403/);
    assert.equal(attempts.length, 1);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, {recursive:true, force:true});
  }
});
