'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const fields = {symbol:$('agent-symbol'), horizon:$('agent-horizon'), mode:$('agent-mode'), evidence:$('agent-evidence'), unknowns:$('agent-unknowns')};
  const cards = $('agent-cards'), state = $('agent-output-state'), version = $('agent-version'), saved = $('agent-saved'), aiState = $('agent-ai-state');
  const storageKey = 'books.agent-studio.draft.v2';
  const labels = {short:'短线',mid:'中线',long:'长线'};
  const roleOrder = ['bull','bear','manager','risk','portfolio'];
  const roles = [
    {id:'bull',name:'多方研究员',en:'Bull Researcher',tone:'positive',focus:'趋势与催化剂',body:e=>e?`围绕已核验事实寻找支持方向的证据，检查价格结构、催化剂和行业相对强弱。当前只做证据整理，不给出确定性收益判断。`:'等待事实输入，不能生成多方论据。',next:'补齐来源时间、价格/成交量和催化剂原文。'},
    {id:'bear',name:'空方研究员',en:'Bear Researcher',tone:'negative',focus:'反证与缺口',body:e=>e?`对同一证据提出反例，检查估值压力、失效条件、流动性和是否把旧信息当成新信息。`:'等待事实输入，不能生成空方论据。',next:'至少提供一个可证伪条件和一个风险来源。'},
    {id:'manager',name:'研究经理',en:'Research Manager',tone:'neutral',focus:'证据冲突',body:e=>e?`按来源、时点、覆盖范围和可复核性比较多空证据；规则层结论为“${e.unknowns?'等待确认':'观察'}”，AI 不能覆盖这个结论。`:'没有双方证据，无法做冲突裁决。',next:'让双方引用同一观察窗口，再进行样本外核对。'},
    {id:'risk',name:'风控审查',en:'Risk Officer',tone:'risk',focus:'失效与暴露',body:e=>e?`检查数据新鲜度、事件风险、最大可接受回撤、成交约束和组合相关性；缺少参数时保持观望。`:'尚无数据，风控状态保持未评估。',next:'补齐回撤上限、仓位上限和事件日历。'},
    {id:'portfolio',name:'组合经理',en:'Portfolio Manager',tone:'portfolio',focus:'行动门槛',body:e=>e?`在${labels[fields.horizon.value]}框架下，只允许输出“观察 / 等待确认 / 进入模拟计划”三选一；当前规则结果不会发出订单。`:'没有证据包，组合动作保持空白。',next:'完成证据与风控字段后再进入模拟计划。'}
  ];
  const standard = {schema:'books.agent.request.v1',version:'rules-v2',freshness:'来源时间必须可见；过期数据降级为待核',evidence:'观点必须绑定事实、来源、时间和覆盖范围',risk:'缺失回撤、流动性或事件参数时保持观望',execution:'规则层和 AI 层都不能产生订单'};
  const limits={symbol:80,evidence:20000,unknowns:8000,aiNote:800};
  const clip=(value,limit)=>String(value??'').slice(0,limit);
  const safeField=(field,limit)=>clip(field?.value||'',limit);
  const hasSourceTime=value=>/(来源|原文|公告|财报|时间|日期|20\d{2}|https?:\/\/)/i.test(value);
  const withTimeout=(promise,ms)=>typeof setTimeout!=='function'?promise:new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('agent_ai_timeout')),ms);Promise.resolve(promise).then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
  function esc(x){return String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function save(){try{localStorage.setItem(storageKey,JSON.stringify({symbol:safeField(fields.symbol,limits.symbol),horizon:fields.horizon.value,mode:fields.mode.value,evidence:safeField(fields.evidence,limits.evidence),unknowns:safeField(fields.unknowns,limits.unknowns)}));saved.textContent='草稿已保存到当前浏览器';}catch{saved.textContent='本机存储不可用 · 仍可临时推演';}}
  function load(){try{const data=JSON.parse(localStorage.getItem(storageKey)||'{}');for(const [k,v] of Object.entries(data))if(fields[k]&&typeof v==='string')fields[k].value=v;}catch{}}
  function ruleResult(){
    const evidence=safeField(fields.evidence,limits.evidence).trim(), unknowns=safeField(fields.unknowns,limits.unknowns).trim(), sourceTime=hasSourceTime(evidence);
    const blocked=!evidence?'没有证据包':!sourceTime?'缺少来源或时间锚点':unknowns?'存在待核问题，规则层不升级结论':'';
    return {hasEvidence:Boolean(evidence),unknowns:Boolean(unknowns),sourceTime,decision:evidence&&!blocked?'观察':evidence?'等待确认':'未评估',reason:blocked||'证据包已建立，但仍需样本外验证'};
  }
  function request(){return {schema:standard.schema,version:standard.version,symbol:safeField(fields.symbol,limits.symbol).trim()||'未命名标的',horizon:fields.horizon.value, evidence:safeField(fields.evidence,limits.evidence).trim(), unknowns:safeField(fields.unknowns,limits.unknowns).trim(), rules:standard, clientMode:fields.mode.value};}
  function normalizeAi(result){
    const notes={};
    if(!result || typeof result!=='object' || !result.roles || typeof result.roles!=='object') return notes;
    for(const id of roleOrder){const value=result.roles[id];if(typeof value==='string'&&value.trim()) notes[id]=value.trim().slice(0,limits.aiNote);}
    return notes;
  }
  function render(aiNotes={}){
    const rules=ruleResult(), symbol=safeField(fields.symbol,limits.symbol).trim()||'未命名标的';
    state.textContent=rules.hasEvidence?(rules.unknowns?'已完成规则层 · 等待确认':'已完成规则层 · 仍需人工核验'):'等待证据包';
    version.textContent=rules.hasEvidence?'LOCAL-'+new Date().toISOString().slice(0,16).replace(/[-:T]/g,''):'—';
    cards.innerHTML=roles.map((role,index)=>{
      const note=aiNotes[role.id]?`<div class="agent-ai-note"><span>AI 补充 · 未改变规则结论</span><p>${esc(aiNotes[role.id])}</p></div>`:'';
      return `<article class="agent-card agent-${role.tone}"><header><span class="agent-role-index">0${index+1}</span><div><h3>${role.name}</h3><small>${role.en} · ${role.focus}</small></div><span class="agent-card-state">${rules.hasEvidence?'已输出规则草稿':'待输入'}</span></header><p>${esc(role.body({unknowns:rules.unknowns}))}</p>${note}<div class="agent-evidence"><span>研究对象</span><b>${esc(symbol)}</b><span>规则结论</span><b>${esc(rules.decision)}</b><span>下一步</span><b>${esc(role.next)}</b></div></article>`;
    }).join('')+`<aside class="agent-unknowns"><strong>规则底线</strong><p>${esc(rules.reason)}。数据新鲜度、来源许可和风控参数缺失时，不生成确定性结论。</p></aside>`;
  }
  function updateAiState(text){if(aiState) aiState.textContent=text;}
  let runToken=0;
  async function run(){
    const token=++runToken;
    save(); render();
    if(fields.mode.value!=='hybrid'){updateAiState('规则模式运行中 · 未调用 AI');return;}
    const adapter=window.BooksAgentAdapter;
    if(!adapter || typeof adapter.analyze!=='function'){updateAiState('AI 接口未连接 · 已回退规则层');return;}
    updateAiState('AI 增强请求中 · 规则结论保持锁定');
    try { const response=await withTimeout(adapter.analyze(request()),8000); if(token!==runToken)return; render(normalizeAi(response)); updateAiState('AI 增强已返回 · 仅补充解释，未改变规则结论'); }
    catch { if(token===runToken)updateAiState('AI 接口失败 · 已回退规则层'); }
  }
  $('agent-run').addEventListener('click',run);
  $('agent-reset').addEventListener('click',()=>{runToken++;Object.values(fields).forEach(field=>field.value='');fields.mode.value='rules';localStorage.removeItem(storageKey);saved.textContent='已清空本机草稿';updateAiState('规则模式运行中 · 未调用 AI');render();});
  Object.values(fields).forEach(field=>{field.addEventListener('input',()=>{runToken++;save();if(field===fields.mode)render();});field.addEventListener('change',()=>{runToken++;save();if(field===fields.mode)render();});});
  window.BooksAgentBridge={version:'books.agent.bridge.v1',schema:standard.schema,getRequest:request,setAdapter(adapter){window.BooksAgentAdapter=adapter;updateAiState('AI 适配器已注册 · 运行时仍受规则层约束');},run};
  load(); render();
})();
