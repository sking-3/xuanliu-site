import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {gunzipSync, gzipSync} from 'node:zlib';
import {parseSecIndustrySub} from './us-sec-universe.mjs';

const run = promisify(execFile);
const schema = 'books.us.sec-industry-index.v1';
const archiveRoot = 'https://www.sec.gov/files/dera/data/financial-statement-data-sets/';
const dayMs = 86400000;
const publicationLagDays = 45;
const maxArchiveBytes = 192 * 1024 ** 2;
const maxIndexBytes = 16 * 1024 ** 2;

export function secIndustryQuarter(asOf) {
  const day = String(asOf).slice(0, 10);
  const stamp = Date.parse(day + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== day) {
    throw Error('SEC行业索引需要有效的收盘日期');
  }
  const dayAfterEligibleEnd = new Date(stamp - (publicationLagDays - 1) * dayMs);
  const completedAt = new Date(Date.UTC(dayAfterEligibleEnd.getUTCFullYear(), Math.floor(dayAfterEligibleEnd.getUTCMonth() / 3) * 3, 0));
  const quarter = completedAt.getUTCFullYear() + 'q' + (Math.floor(completedAt.getUTCMonth() / 3) + 1);
  return {quarter, asOf:completedAt.toISOString().slice(0, 10), source:archiveRoot + quarter + '.zip'};
}

async function readIndex(path) {
  try {
    return JSON.parse(gunzipSync(await readFile(path), {maxOutputLength:maxIndexBytes}).toString('utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

export async function loadSecIndustryIndex({directory, asOf, readAt, get}) {
  const reference = secIndustryQuarter(asOf);
  const stamp = Date.parse(readAt);
  if (!Number.isFinite(stamp)) throw Error('SEC行业索引需要有效的读取时点');
  const path = join(directory, 'sec-industry-' + reference.quarter + '.json.gz');
  const cached = await readIndex(path);
  if (cached) {
    const valid = cached.schema === schema && cached.quarter === reference.quarter && cached.asOf === reference.asOf &&
      cached.source === reference.source && Date.parse(cached.readAt) <= stamp && Array.isArray(cached.entries) && cached.entries.length;
    if (!valid) throw Error('SEC行业索引缓存与季度或来源不一致');
    return {...reference, readAt:cached.readAt, byCik:new Map(cached.entries)};
  }

  const bytes = await get(reference.source, {timeoutMs:120000, maxBytes:maxArchiveBytes, accept:'application/zip,application/octet-stream'});
  if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes.length > maxArchiveBytes || bytes.readUInt32LE(0) !== 0x04034b50) {
    throw Error('SEC季度财报文件不是受支持的ZIP或超出大小上限');
  }

  await mkdir(directory, {recursive:true});
  const temp = await mkdtemp(join(directory, 'sec-industry-'));
  try {
    const archive = join(temp, 'quarter.zip');
    await writeFile(archive, bytes, {mode:0o600});
    const {stdout} = await run('unzip', ['-p', archive, 'sub.txt'], {maxBuffer:maxIndexBytes, timeout:30000, encoding:'utf8'})
      .catch(error => {throw Error(error.code === 'ENOENT' ? 'SEC季度财报索引需要unzip' : 'SEC季度财报的sub.txt读取失败或超出解压上限');});
    const nextQuarter = new Date(Date.parse(reference.asOf + 'T00:00:00Z') + dayMs).toISOString();
    const byCik = parseSecIndustrySub(stdout, nextQuarter);
    if (!byCik.size) throw Error('SEC季度财报没有可核验的申报分类');
    const next = join(temp, 'index.json.gz');
    await writeFile(next, gzipSync(JSON.stringify({schema, ...reference, readAt, entries:[...byCik]})), {mode:0o600});
    await rename(next, path);
    return {...reference, readAt, byCik};
  } finally {
    await rm(temp, {recursive:true, force:true});
  }
}
