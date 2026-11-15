'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
class El{
  constructor(id){this.id=id;this.value='';this.textContent='';this.innerHTML='';this.events={};}
  addEventListener(name,fn){this.events[name]=fn;}
}
function setup(){
  const ids=['agent-symbol','agent-horizon','agent-mode','agent-evidence','agent-unknowns','agent-cards','agent-output-state','agent-version','agent-saved','agent-ai-state','agent-run','agent-reset'];
  const els=Object.fromEntries(ids.map(id=>[id,new El(id)]));
  els['agent-symbol'].value='AAPL';els['agent-horizon'].value='mid';els['agent-mode'].value='rules';
  const storage=new Map();
  const context={console,Date,JSON,window:{},document:{getElementById:id=>els[id]},localStorage:{setItem:(k,v)=>storage.set(k,v),getItem:k=>storage.get(k)||null,removeItem:k=>storage.delete(k)}};
  vm.runInNewContext(fs.readFileSync('agent-studio.js','utf8'),context);
  return {els,context};
}
const sleep=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
  const h=setup();
  h.els['agent-run'].events.click();
  assert.match(h.els['agent-cards'].innerHTML,/多方研究员/);
  assert.match(h.els['agent-cards'].innerHTML,/空方研究员/);
  assert.match(h.els['agent-cards'].innerHTML,/研究经理/);
  assert.match(h.els['agent-cards'].innerHTML,/风控审查/);
  assert.match(h.els['agent-cards'].innerHTML,/组合经理/);
  assert.match(h.els['agent-output-state'].textContent,/等待证据包/);
  h.els['agent-evidence'].value='收盘价、成交量和公告时间均有来源';
  h.els['agent-unknowns'].value='财报日期仍待确认';
  h.els['agent-run'].events.click();
  assert.match(h.els['agent-cards'].innerHTML,/等待确认/);
  assert.match(h.els['agent-ai-state'].textContent,/规则模式/);
  let received=null;
  h.context.window.BooksAgentBridge.setAdapter({analyze:async request=>{received=request;return {roles:{bull:'补充支持证据',bear:'补充反证'}};}});
  h.els['agent-mode'].value='hybrid';
  h.els['agent-unknowns'].value='';
  h.els['agent-run'].events.click();
  await sleep();
  assert.equal(received.schema,'books.agent.request.v1');
  assert.equal(received.symbol,'AAPL');
  assert.match(h.els['agent-cards'].innerHTML,/AI 补充 · 未改变规则结论/);
  assert.match(h.els['agent-cards'].innerHTML,/规则结论/);
  assert.match(h.els['agent-cards'].innerHTML,/观察/);
  assert.match(h.els['agent-ai-state'].textContent,/AI 增强已返回/);
  console.log('PASS five-agent behavior: rules output, unknown blocking, adapter request, AI fallback boundary');
})().catch(error=>{console.error(error);process.exitCode=1;});
