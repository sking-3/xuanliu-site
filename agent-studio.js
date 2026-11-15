'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const fields = {symbol:$('agent-symbol'), horizon:$('agent-horizon'), mode:$('agent-mode'), evidence:$('agent-evidence'), unknowns:$('agent-unknowns')};
  const layers = {market:$('agent-layer-market'), research:$('agent-layer-research'), news:$('agent-layer-news'), fundamentals:$('agent-layer-fundamentals'), disclosure:$('agent-layer-disclosure')};
  const inputFields=[...Object.values(fields),...Object.values(layers)];
  const cards = $('agent-cards'), layerSummary=$('agent-layer-summary'), state = $('agent-output-state'), version = $('agent-version'), saved = $('agent-saved'), aiState = $('agent-ai-state');
  const storageKey = 'books.agent-studio.draft.v3';
  const labels = {short:'短线',mid:'中线',long:'长线'};
  const roleOrder = ['bull','bear','manager','risk','portfolio'];
  const layerOrder = ['market','research','news','fundamentals','disclosure'];
  const layerMeta = {
    market:{label:'行情层',support:/上涨|突破|放量|强于|高于均线|上行|趋势向上|新高/i,risk:/下跌|跌破|缩量|弱于|下行|波动放大/i},
    research:{label:'研报层',support:/看好|增长|空间|逻辑|催化|订单|上调|目标价/i,risk:/风险|竞争|下调|不确定|降价|假设失效/i},
    news:{label:'新闻层',support:/利好|超预期|签约|订单|政策支持|回购|获批|合作/i,risk:/利空|处罚|诉讼|减持|不及预期|延期|事故/i},
    fundamentals:{label:'基础数据层',support:/增长|盈利|现金流|毛利|ROE|低估|净利|收入/i,risk:/亏损|下降|负债|现金流为负|高估|减值|下滑/i},
    disclosure:{label:'公告层',support:/回购|增持|中标|合同|无处罚|澄清|通过/i,risk:/问询|处罚|减持|违规|诉讼|延期|终止/i}
  };
  const roles = [
    {id:'bull',name:'多方研究员',en:'Bull Researcher',tone:'positive',focus:'趋势与催化剂',body:e=>e.ready?`从${e.support.length?e.support.join('、'):'已核验五层'}寻找支持方向的事实；支持理由必须回到对应层和来源时间。`:'五层证据未完整，不能生成多方论据。',next:'补齐缺失层的来源、时间和可证伪事实。'},
    {id:'bear',name:'空方研究员',en:'Bear Researcher',tone:'negative',focus:'反证与缺口',body:e=>e.risk.length?`识别到${e.risk.join('、')}等反证或风险；任何一项未解决都不能把研究假设升级为交易结论。`:'逐层检查风险词、数据缺口和证据时点，不能只看上涨叙事。',next:'至少提供一个可证伪条件和一个风险来源。'},
    {id:'manager',name:'研究经理',en:'Research Manager',tone:'neutral',focus:'证据冲突',body:e=>`按五层证据的来源、时点和覆盖范围裁决；规则层结论为“${e.decision}”，AI 不能覆盖这个结论。`,next:'让双方引用同一观察窗口，再进行样本外核对。'},
    {id:'risk',name:'风控审查',en:'Risk Officer',tone:'risk',focus:'失效与暴露',body:e=>e.blockers.length?`风控阻断：${e.blockers.join('；')}。缺少回撤、流动性、事件或来源时点参数时保持观望。`:'五层均有来源时间，但仍需补齐回撤、流动性和事件日历。',next:'补齐回撤上限、仓位上限、流动性和事件日历。'},
    {id:'portfolio',name:'组合经理',en:'Portfolio Manager',tone:'portfolio',focus:'行动门槛',body:e=>`在${labels[fields.horizon.value]}框架下，根据五层规则结果只输出“观察 / 等待确认 / 进入模拟计划”三选一；当前结果为“${e.decision}”，不发送订单。`,next:'完成证据和风控字段后再进入模拟计划。'}
  ];
  const standard = {schema:'books.agent.request.v1',version:'rules-v3',freshness:'每层必须有来源与时间；过期数据降级为待核',evidence:'观点必须绑定五层事实、来源、时间和覆盖范围',risk:'缺失回撤、流动性或事件参数时保持观望',execution:'规则层和 AI 层都不能产生订单'};
  const limits={symbol:80,evidence:20000,unknowns:8000,layer:6000,aiNote:800};
  const clip=(value,limit)=>String(value??'').slice(0,limit);
  const safeField=(field,limit)=>clip(field?.value||'',limit);
  const hasSourceTime=value=>/(来源|原文|公告|财报|时间|日期|20\d{2}|https?:\/\/)/i.test(value);
  const withTimeout=(promise,ms)=>typeof setTimeout!=='function'?promise:new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('agent_ai_timeout')),ms);Promise.resolve(promise).then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
  function esc(x){return String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function readLayers(){return layerOrder.map(id=>{const text=safeField(layers[id],limits.layer).trim(),meta=layerMeta[id];const status=!text?'missing':!hasSourceTime(text)?'unverified':'ready';const support=text&&meta.support.test(text)?[meta.label+'支持因素']:[];const riskText=text.replace(/无处罚|没有处罚|无诉讼|没有诉讼/g,'');const risk=riskText&&meta.risk.test(riskText)?[meta.label+'反证']:[];return {id,label:meta.label,text,status,support,risk};});}
  function save(){try{localStorage.setItem(storageKey,JSON.stringify({symbol:safeField(fields.symbol,limits.symbol),horizon:fields.horizon.value,mode:fields.mode.value,evidence:safeField(fields.evidence,limits.evidence),unknowns:safeField(fields.unknowns,limits.unknowns),layers:Object.fromEntries(layerOrder.map(id=>[id,safeField(layers[id],limits.layer)]))}));saved.textContent='草稿已保存到当前浏览器';}catch{saved.textContent='本机存储不可用 · 仍可临时推演';}}
  function load(){try{const data=JSON.parse(localStorage.getItem(storageKey)||'{}');for(const [k,v] of Object.entries(data)){if(fields[k]&&typeof v==='string')fields[k].value=v;if(k==='layers'&&v&&typeof v==='object')for(const id of layerOrder)if(layers[id]&&typeof v[id]==='string')layers[id].value=v[id];}}catch{}}
  function ruleResult(){
    const evidence=safeField(fields.evidence,limits.evidence).trim(), unknowns=safeField(fields.unknowns,limits.unknowns).trim(), snapshots=readLayers();
    const blockers=[]; if(!evidence)blockers.push('总体事实为空'); if(!hasSourceTime(evidence))blockers.push('总体事实缺少来源或时间锚点');
    snapshots.forEach(layer=>{if(layer.status==='missing')blockers.push(`${layer.label}缺失`);else if(layer.status==='unverified')blockers.push(`${layer.label}缺少来源或时间`);}); if(unknowns)blockers.push('存在待核问题');
    const support=[...new Set(snapshots.flatMap(x=>x.support))], risk=[...new Set(snapshots.flatMap(x=>x.risk))];
    if(risk.length)blockers.push('五层中识别到反证或风险');
    const ready=snapshots.every(x=>x.status==='ready') && Boolean(evidence) && hasSourceTime(evidence) && !unknowns && !risk.length;
    const decision=ready?'观察':evidence?'等待确认':'未评估';
    const reason=decision==='未评估'?'没有总体事实':decision==='等待确认'?blockers.join('；'):'五层来源、时间和总体证据均已提供；仍需样本外验证';
    return {hasEvidence:Boolean(evidence),unknowns:Boolean(unknowns),snapshots,ready,decision,reason,blockers,support,risk};
  }
  function request(){return {schema:standard.schema,version:standard.version,symbol:safeField(fields.symbol,limits.symbol).trim()||'未命名标的',horizon:fields.horizon.value,evidence:safeField(fields.evidence,limits.evidence).trim(),unknowns:safeField(fields.unknowns,limits.unknowns).trim(),layers:Object.fromEntries(readLayers().map(layer=>[layer.id,{status:layer.status,text:layer.text}])),rules:standard,clientMode:fields.mode.value};}
  function normalizeAi(result){const notes={};if(!result||typeof result!=='object'||!result.roles||typeof result.roles!=='object')return notes;for(const id of roleOrder){const value=result.roles[id];if(typeof value==='string'&&value.trim())notes[id]=value.trim().slice(0,limits.aiNote);}return notes;}
  function render(aiNotes={}){
    const rules=ruleResult(),symbol=safeField(fields.symbol,limits.symbol).trim()||'未命名标的';state.textContent=rules.hasEvidence?(rules.decision==='等待确认'?'已完成规则层 · 等待确认':'已完成规则层 · 仍需人工核验'):'等待证据包';version.textContent=rules.hasEvidence?'LOCAL-'+new Date().toISOString().slice(0,16).replace(/[-:T]/g,''):'—';
    if(layerSummary)layerSummary.innerHTML=rules.snapshots.map(layer=>`<span class="agent-layer-status is-${layer.status}"><b>${layer.label}</b>${layer.status==='ready'?'已核验':layer.status==='unverified'?'待补来源/时间':'缺失'}</span>`).join('');
    cards.innerHTML=roles.map((role,index)=>{const note=aiNotes[role.id]?`<div class="agent-ai-note"><span>AI 补充 · 未改变规则结论</span><p>${esc(aiNotes[role.id])}</p></div>`:'';return `<article class="agent-card agent-${role.tone}"><header><span class="agent-role-index">0${index+1}</span><div><h3>${role.name}</h3><small>${role.en} · ${role.focus}</small></div><span class="agent-card-state">${rules.ready?'已完成规则层':rules.hasEvidence?'待核':'待输入'}</span></header><p>${esc(role.body(rules))}</p>${note}<div class="agent-evidence"><span>研究对象</span><b>${esc(symbol)}</b><span>规则结论</span><b>${esc(rules.decision)}</b><span>下一步</span><b>${esc(role.next)}</b></div></article>`;}).join('')+`<aside class="agent-unknowns"><strong>五层规则底线</strong><p>${esc(rules.reason)}。支持因素：${esc(rules.support.join('、')||'未识别')}；反证/风险：${esc(rules.risk.join('、')||'未识别')}。</p></aside>`;
  }
  function updateAiState(text){if(aiState)aiState.textContent=text;}
  let runToken=0;
  async function run(){const token=++runToken;save();render();if(fields.mode.value!=='hybrid'){updateAiState('规则模式运行中 · 未调用 AI');return;}const adapter=window.BooksAgentAdapter;if(!adapter||typeof adapter.analyze!=='function'){updateAiState('AI 接口未连接 · 已回退规则层');return;}updateAiState('AI 增强请求中 · 规则结论保持锁定');try{const response=await withTimeout(adapter.analyze(request()),8000);if(token!==runToken)return;render(normalizeAi(response));updateAiState('AI 增强已返回 · 仅补充解释，未改变规则结论');}catch{if(token===runToken)updateAiState('AI 接口失败 · 已回退规则层');}}
  $('agent-run').addEventListener('click',run);
  $('agent-reset').addEventListener('click',()=>{runToken++;inputFields.forEach(field=>field.value='');localStorage.removeItem(storageKey);saved.textContent='已清空本机草稿';updateAiState('规则模式运行中 · 未调用 AI');render();});
  inputFields.forEach(field=>{field.addEventListener('input',()=>{runToken++;save();if(field===fields.mode)render();});field.addEventListener('change',()=>{runToken++;save();if(field===fields.mode)render();});});
  window.BooksAgentBridge={version:'books.agent.bridge.v1',schema:standard.schema,getRequest:request,setAdapter(adapter){window.BooksAgentAdapter=adapter;updateAiState('AI 适配器已注册 · 运行时仍受规则层约束');},run};
  load();render();
})();
