'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const fields = {symbol:$('agent-symbol'), horizon:$('agent-horizon'), evidence:$('agent-evidence'), unknowns:$('agent-unknowns')};
  const cards = $('agent-cards'), state = $('agent-output-state'), version = $('agent-version'), saved = $('agent-saved');
  const storageKey = 'books.agent-studio.draft.v1';
  const labels = {short:'短线',mid:'中线',long:'长线'};
  const roles = [
    {id:'bull',name:'多方研究员',en:'Bull Researcher',tone:'positive',focus:'趋势与催化剂',body:e=>e?`围绕“${e}”寻找支持方向的可验证事实，重点检查价格结构、事件催化和行业相对强弱。`:'等待事实输入，不能生成多方论据。',next:'补齐来源时间、价格/成交量和催化剂原文。'},
    {id:'bear',name:'空方研究员',en:'Bear Researcher',tone:'negative',focus:'反证与缺口',body:e=>e?`对同一证据提出反例：检查估值压力、失效条件、流动性和是否存在把旧信息当新信息的情况。`:'等待事实输入，不能生成空方论据。',next:'至少提供一个可证伪条件和一个风险来源。'},
    {id:'manager',name:'研究经理',en:'Research Manager',tone:'neutral',focus:'证据冲突',body:e=>e?`把多空观点按来源、时点和可复核性分级；当前只允许形成“研究假设”，不会把观点升级为买入信号。`:'没有双方证据，无法做冲突裁决。',next:'让双方引用同一观察窗口，再进行样本外核对。'},
    {id:'risk',name:'风控审查',en:'Risk Officer',tone:'risk',focus:'失效与暴露',body:e=>e?`先检查数据新鲜度、事件风险、最大可接受回撤、成交约束和组合相关性；缺少参数时默认保持观望。`:'尚无数据，风控状态保持未评估。',next:'补齐回撤上限、仓位上限和事件日历。'},
    {id:'portfolio',name:'组合经理',en:'Portfolio Manager',tone:'portfolio',focus:'行动门槛',body:e=>e?`在${labels[fields.horizon.value]}框架下，只输出“观察 / 等待确认 / 进入模拟计划”三选一，不发送订单。`:'没有证据包，组合动作保持空白。',next:'完成证据与风控字段后再进入模拟计划。'}
  ];
  function esc(x){return String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function save(){localStorage.setItem(storageKey,JSON.stringify(Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,v.value]))));saved.textContent='草稿已保存到当前浏览器';}
  function load(){try{const data=JSON.parse(localStorage.getItem(storageKey)||'{}');for(const [k,v] of Object.entries(data))if(fields[k]&&typeof v==='string')fields[k].value=v;}catch{}}
  function render(){
    const evidence=fields.evidence.value.trim(), symbol=fields.symbol.value.trim()||'未命名标的', unknowns=fields.unknowns.value.trim();
    const hasEvidence=Boolean(evidence); state.textContent=hasEvidence?'已完成本机推演 · 仍需人工核验':'等待证据包'; version.textContent=hasEvidence?'LOCAL-'+new Date().toISOString().slice(0,16).replace(/[-:T]/g,''):'—';
    cards.innerHTML=roles.map((role,index)=>`<article class="agent-card agent-${role.tone}"><header><span class="agent-role-index">0${index+1}</span><div><h3>${role.name}</h3><small>${role.en} · ${role.focus}</small></div><span class="agent-card-state">${hasEvidence?'已输出草稿':'待输入'}</span></header><p>${esc(role.body(evidence))}</p><div class="agent-evidence"><span>研究对象</span><b>${esc(symbol)}</b><span>下一步</span><b>${esc(role.next)}</b></div></article>`).join('') + (unknowns?`<aside class="agent-unknowns"><strong>待核问题</strong><p>${esc(unknowns)}</p></aside>`:'');
  }
  $('agent-run').addEventListener('click',()=>{save();render();});
  $('agent-reset').addEventListener('click',()=>{Object.values(fields).forEach(field=>field.value='');localStorage.removeItem(storageKey);saved.textContent='已清空本机草稿';render();});
  Object.values(fields).forEach(field=>field.addEventListener('input',save));
  load();render();
})();
