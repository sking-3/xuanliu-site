import * as core from './viprasol-core.mjs';
import * as structure from './viprasol-structure.mjs';
import * as flow from './viprasol-flow.mjs';
import * as multisource from './viprasol-multisource.mjs';
import {validateBars} from './viprasol-math.mjs';

const modules = [core, structure, flow, multisource];
export const catalog = modules.flatMap(module => module.catalog.map(definition => ({...definition,
  sourceFile: definition.sourceFile.replace(/^indicators\//,''),
})));
export function evaluateIndicator(id, bars, params = {}, context = {}) {
  const module = modules.find(item => item.catalog.some(definition => definition.id === id));
  if (!module) throw Error('未找到已移植的指标');
  const result = module.evaluateIndicator(id, bars, params, context);
  return {...result, status: result.status || 'ready', missingDependencies: result.missingDependencies || []};
}
export function verifySnapshot(snapshot, previous = null) {
  if (!snapshot || snapshot.schemaVersion !== 1 || !['ready','stale','error','blocked','stopped'].includes(snapshot.status)) throw Error('行情状态或格式无效');
  if (!snapshot.bars?.length) throw Error('尚无已归档的真实日线');
  validateBars(snapshot.bars);
  if (snapshot.source?.symbol !== 'BTC/USD' || !snapshot.source?.name) throw Error('当前指标研究只接本站已核验的BTC/USD日线');
  const captured = Date.parse(snapshot.retrievedAt), closed = Date.parse(snapshot.latestClosedAt);
  if (!Number.isFinite(captured) || !Number.isFinite(closed) || captured > Date.now()+60000 || closed > captured || closed !== snapshot.bars.at(-1).time + 86400000) throw Error('来源时间与完整日线不一致');
  for (let i=1;i<snapshot.bars.length;i++) if(snapshot.bars[i].time-snapshot.bars[i-1].time!==86400000) throw Error('行情日线存在缺口');
  if (previous && (closed<Date.parse(previous.latestClosedAt) || captured<Date.parse(previous.retrievedAt))) throw Error('拒绝用更旧的数据替换当前归档');
  return snapshot;
}
