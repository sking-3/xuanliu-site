'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
class El{constructor(id){this.id=id;this.value='';this.textContent='';this.innerHTML='';this.events={};}addEventListener(n,f){this.events[n]=f;}}
function setup(){
  const ids=['agent-symbol','agent-horizon','agent-mode','agent-evidence','agent-unknowns','agent-cards','agent-output-state','agent-version','agent-saved','agent-ai-state','agent-run','agent-reset'];
  const els=Object.fromEntries(ids.map(id=>[id,new El(id)]));els['agent-symbol'].value='TEST';els['agent-horizon'].value='mid';els['agent-mode'].value='rules';
  const storage=new Map(),context={console,Date,JSON,window:{},document:{getElementById:id=>els[id]},localStorage:{setItem:(k,v)=>storage.set(k,v),getItem:k=>storage.get(k)||null,removeItem:k=>storage.delete(k)}};
  vm.runInNewContext(fs.readFileSync('agent-studio.js','utf8'),context);return {els,context};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function shuffle(values,seed){const out=[...values];let x=seed;for(let i=out.length-1;i>0;i--){x=(x*1664525+1013904223)>>>0;const j=x%(i+1);[out[i],out[j]]=[out[j],out[i]];}return out;}
(async()=>{
  const fixtures=[];
  for(let i=0;i<60;i++){
    const hasEvidence=i%4!==0,hasUnknown=i%3===0;
    fixtures.push({evidence:hasEvidence?`事实样本 ${i}，来源时间 2026-01-${String((i%9)+1).padStart(2,'0')}`:'',unknowns:hasUnknown?'待核问题：事件时间或覆盖范围未确认':'',expected:hasEvidence?(hasUnknown?'等待确认':'观察'):'等待证据包'});
  }
  let checked=0;
  for(const fixture of shuffle(fixtures,20261115)){
    const h=setup(),e=h.els;e['agent-evidence'].value=fixture.evidence;e['agent-unknowns'].value=fixture.unknowns;e['agent-run'].events.click();
    if(fixture.expected==='等待证据包')assert.match(e['agent-output-state'].textContent,/等待证据包/);
    else assert.match(e['agent-cards'].innerHTML,new RegExp(fixture.expected));
    for(const role of ['多方研究员','空方研究员','研究经理','风控审查','组合经理'])assert.match(e['agent-cards'].innerHTML,new RegExp(role));
    checked++;
  }
  const missing=setup();missing.els['agent-evidence'].value='价格和成交量出现变化，但没有来源时间';missing.els['agent-run'].events.click();assert.match(missing.els['agent-cards'].innerHTML,/等待确认/);
  const h=setup(),e=h.els,pending=[];h.context.window.BooksAgentBridge.setAdapter({analyze:req=>new Promise(resolve=>pending.push({req,resolve}))});e['agent-mode'].value='hybrid';e['agent-evidence'].value='旧一代证据';e['agent-run'].events.click();e['agent-evidence'].value='新一代证据';e['agent-run'].events.click();assert.equal(pending.length,2);pending[0].resolve({decision:'进入模拟计划',order:'BUY NOW',roles:{bull:'旧响应'}});await tick();assert.doesNotMatch(e['agent-cards'].innerHTML,/旧响应/);pending[1].resolve({decision:'下单',roles:{bull:'新响应'}});await tick();assert.match(e['agent-cards'].innerHTML,/新响应/);assert.match(e['agent-cards'].innerHTML,/观察/);assert.doesNotMatch(e['agent-cards'].innerHTML,/下单/);
  pending.length=0;e['agent-evidence'].value='恶意文本';e['agent-run'].events.click();assert.equal(pending.length,1);pending[0].resolve({roles:{bull:'<script>alert(1)</script>'},decision:'进入模拟计划'});await tick();assert.doesNotMatch(e['agent-cards'].innerHTML,/<script>/);assert.match(e['agent-cards'].innerHTML,/观察/);
  console.log(`PASS blind multi-run: ${checked} hidden rule fixtures, stale-response isolation and hostile AI output`);
})().catch(error=>{console.error(error);process.exitCode=1;});
