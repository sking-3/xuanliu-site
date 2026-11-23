import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {publicHourly} from './a-share-hourly.mjs';
const PUBLIC = '/api/a-share-daily/schemes';
const PRIVATE = '/api/research-control/schemes';

export function createSchemeApi({store, directory, schedule = () => {}}) {
  async function collectionStatus() {
    if (!directory) return null;
    try { return JSON.parse(await readFile(join(directory, 'status.json'), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      return {attempt: {status: 'failed', error: '采集状态文件暂不可读；保留已完成方案结果。'}};
    }
  }
  async function hourlyStatus() {
    if (!directory) return null;
    try { return publicHourly(JSON.parse(await readFile(join(directory, 'hourly.json'), 'utf8'))); }
    catch { return null; }
  }
  async function handle(req, res, {path, url, user, readJson, json}) {
    if (path !== PUBLIC && path !== PRIVATE && path !== PRIVATE + '/enabled') return false;
    try {
      if (req.method === 'GET' && path === PUBLIC) {
        const runId = url.searchParams.get('run');
        if (runId) {
          const run = store.getRun(runId);
          if (!run) { json(res, 404, {error: 'run_not_found'}); return true; }
          json(res, 200, {run});
          return true;
        }
        const id = url.searchParams.get('id');
        if (!id) { json(res, 200, {schemes: store.list()}); return true; }
        const scheme = store.get(id);
        if (!scheme) { json(res, 404, {error: 'scheme_not_found'}); return true; }
        json(res, 200, {scheme, runs: store.runs(id), latestRun: store.latestRun(id), tracks: store.tracks(id), monitor: store.monitor(id), collection: await collectionStatus(), hourly: await hourlyStatus()});
        return true;
      }
      if (req.method !== 'POST' || path === PUBLIC) {
        json(res, 405, {error: 'method_not_allowed'}); return true;
      }
      if (!user || user.status !== 'active') {
        json(res, 401, {error: 'sign_in_required'}); return true;
      }
      const body = await readJson(req, 128 * 1024);
      const scheme = path.endsWith('/enabled')
        ? store.setEnabled({ownerId: user.id, id: body.id, enabled: body.enabled})
        : store.save({...body, ownerId: user.id});
      if (scheme.enabled) schedule(scheme.id);
      json(res, path.endsWith('/enabled') ? 200 : 201, {scheme});
      return true;
    } catch (error) {
      if (!error.status || error.status >= 500) throw error;
      json(res, error.status, {error: error.code || 'invalid_scheme', message: error.message});
      return true;
    }
  }
  return {handle};
}
