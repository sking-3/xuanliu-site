import {mkdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {setTimeout as sleep} from 'node:timers/promises';

export const sourceId='cninfo-public-announcements-v1';
export const directory='institution-disclosures-v1';
export const endpoint='https://www.cninfo.com.cn/new/fulltextSearch/full';
const keywords=['投资者关系活动记录表','机构调研'];
const partialPageErrors=new Set(['invalid_page','changed_page','incomplete_page','page_limit']);
const offset=8*3600000;
const mainBoard=code=>/^(?:(?:600|601|603|605)\d{3}\.SH|(?:000|001|002|003)\d{3}\.SZ)$/.test(code);
const stamp=now=>new Date(now()).toISOString();
const localDay=time=>new Date(time+offset).toISOString().slice(0,10);
const failure=(code,message)=>Object.assign(Error(message),{code,publicReason:message});
async function json(path){try{return JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function atomic(path,body){const temp=path+'.'+process.pid+'.tmp';await writeFile(temp,body);await rename(temp,path);}
async function atomicJson(path,value){await atomic(path,JSON.stringify(value));}
function sourceUrl(path){
  if(typeof path!=='string')throw failure('unsafe_url','公告原文地址不在允许的官方路径内。');
  let url;try{url=new URL(path,'https://static.cninfo.com.cn/');}catch{throw failure('unsafe_url','公告原文地址格式异常。');}
  if(!['https://static.cninfo.com.cn','https://dataclouds.cninfo.com.cn'].includes(url.origin)||url.username||url.password||url.search||url.hash||!/\.pdf$/i.test(url.pathname)||url.origin==='https://static.cninfo.com.cn'&&!/^\/finalpage\/\d{4}-\d{2}-\d{2}\/\d{1,30}\.(?:PDF|pdf)$/.test(url.pathname))throw failure('unsafe_url','公告原文地址不在允许的官方路径内。');
  return url.href;
}

function event(title){
  if(/减持/.test(title))return {kind:'shareholder_decrease',summary:'股东减持相关披露；计划、进展与已实施数量须分别核对。'};
  if(/增持/.test(title))return {kind:'shareholder_increase',summary:/进展|完成|实施/.test(title)?'股东增持进展披露；不等于机构实时买入。':'股东增持计划披露；不表示计划已经实施。'};
  if(/调研|投资者关系活动/.test(title))return {kind:'research_visit',summary:'调研或投资者关系活动披露；参与调研不代表买入或持仓。'};
  if(/专业投资机构|共同.*(?:设立|成立).*基金/.test(title))return {kind:'investment_fund_partnership',summary:'公司与投资机构合作事项；不代表机构在二级市场增持该股票。'};
  if(/基金.*(?:持仓|持股|持有)/.test(title))return {kind:'fund_holding',summary:'基金持股相关披露；报告期持仓不等于当前持仓。'};
  if(/前十.*股东|股东持股/.test(title))return {kind:'shareholder_holding',summary:'股东持股资料披露；不能据此推断当日资金流向。'};
  if(/回购/.test(title))return {kind:'repurchase',summary:/首次实施|进展|完成/.test(title)?'公司回购进展披露；不等于外部机构买入。':'公司回购相关披露；实施情况须另行核对。'};
  if(/员工持股|股权激励/.test(title))return {kind:'employee_share_plan',summary:'员工持股或激励事项；不代表外部机构买入。'};
  return {kind:'other',summary:'公司公开公告；未推断机构持仓或买卖行为。'};
}

/** A midnight announcementTime is a date label, not proof of publication at midnight. */
export function parseAnnouncement(row,{allowedUniverse,firstSeenAt,now=Date.now,expectedCode}={}){
  if(!row||typeof row.secCode!=='string'||!/^\d{5,6}$/.test(row.secCode))throw failure('invalid_record','公告证券代码格式异常。');
  if(row.secCode.length===5)return null;
  const code=row.secCode+'.'+(row.secCode.startsWith('6')?'SH':'SZ');
  if(!mainBoard(code)||!allowedUniverse.has(code)||expectedCode&&code!==expectedCode)return null;
  if(typeof row.announcementId!=='string'||!/^\d{1,30}$/.test(row.announcementId)||typeof row.announcementTitle!=='string'||!Number.isSafeInteger(row.announcementTime)||row.announcementTime<=0)throw failure('invalid_record','公告身份、标题或日期格式异常。');
  const sourceDate=localDay(row.announcementTime),today=localDay(now());
  if(sourceDate>today||row.announcementTime>now())throw failure('future_publication','公告日期晚于本次读取时间，未发布本轮结果。');
  const title=row.announcementTitle.replace(/<\/?em>/g,'').trim();
  if(!title||title.length>600||/[<>\u0000-\u001f]/.test(title))throw failure('invalid_title','公告标题格式异常。');
  const url=sourceUrl(row.adjunctUrl);
  const midnight=(row.announcementTime+offset)%86400000===0;
  return {id:row.announcementId,code,title,url,sourceDate,publishedAt:midnight?null:new Date(row.announcementTime).toISOString(),precision:midnight?'day':'minute',firstSeenAt,...event(title)};
}

function parsePage(payload){
  if(payload?.announcements===null&&payload.totalAnnouncement===0&&payload.hasMore===false)payload={...payload,announcements:[]};
  if(!payload||!Array.isArray(payload.announcements)||!Number.isSafeInteger(payload.totalAnnouncement)||payload.totalAnnouncement<0||typeof payload.hasMore!=='boolean')throw failure('invalid_page','公告列表或分页格式异常。');
  const ids=payload.announcements.map(row=>row?.secCode+':'+row?.announcementId);
  if(new Set(ids).size!==ids.length||payload.hasMore&&!ids.length)throw failure('duplicate_page','公告分页包含重复记录或无进展，未发布本轮结果。');
  return payload;
}

async function current(root){
  const pointer=await json(join(root,'current.json'));
  if(!pointer)return null;
  if(pointer.sourceId!==sourceId||!/^\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/.test(pointer.file||''))throw failure('invalid_pointer','已保存公告指针格式异常。');
  const value=await json(join(root,pointer.file));
  if(value?.sourceId!==sourceId||!['complete','partial'].includes(value.status)||!value.byCode)throw failure('invalid_snapshot','已保存公告结果格式异常。');
  return value;
}

export async function readInstitutionDisclosures({dataDir}={}){
  const root=join(dataDir,directory),last=await current(root),attempt=await json(join(root,'status.json'));
  return {...(last||{sourceId,checkedAt:null,byCode:{}}),...(attempt||{status:'unconfigured',reason:'尚未完成公开公告采集。'})};
}

/** Selected-stock enrichment is capped at 20 distinct codes/day; discovery is a three-page recent sample. */
export async function collectInstitutionDisclosures({dataDir,allowedUniverse,selectedCodes=[],discover=true,fetch:request=globalThis.fetch,now=Date.now,wait=sleep,interval=1500}={}){
  if(!dataDir)throw TypeError('公告任务需要明确的数据目录');
  const root=join(dataDir,directory);await mkdir(root,{recursive:true});
  const day=localDay(now()),previous=await current(root);
  const publishStatus=async(status,reason)=>{const attempt={status,checkedAt:stamp(now),sourceId,...(reason?{reason}:{})};await atomicJson(join(root,'status.json'),attempt);return {...attempt,byCode:previous?.byCode||{}};};
  const permitted=new Set(Array.from(allowedUniverse||[],stock=>typeof stock==='string'?stock:stock.code).filter(mainBoard));
  if(!permitted.size)return publishStatus('unconfigured','缺少已确认的沪深主板名册；未查询任何证券。');
  const selected=[...new Set(selectedCodes)];
  if(selected.some(code=>!permitted.has(code)))return publishStatus('failed','待核证券不在已确认主板名册内；未查询任何证券。');
  const lock=join(root,'worker.lock');
  try{await writeFile(lock,String(process.pid),{flag:'wx'});}catch(error){
    if(error.code!=='EEXIST')throw error;
    const pid=Number(await readFile(lock,'utf8'));
    if(!Number.isSafeInteger(pid)||pid<=0)return publishStatus('failed','公告任务锁格式异常，未启动重复任务。');
    let alive=true;try{process.kill(pid,0);}catch(exit){if(exit.code!=='ESRCH')throw exit;alive=false;}
    if(alive)return publishStatus('running','已有公告任务运行，本次未重复查询。');
    await unlink(lock);await writeFile(lock,String(process.pid),{flag:'wx'});
  }
  try{
    const stored=await json(join(root,'state.json'))||{};
    const state={day,codes:stored.day===day?stored.codes||[]:[],lastRequestAt:stored.lastRequestAt||0,hold:stored.hold||null};
    if(state.hold)return publishStatus('held','公开公告来源已暂停（HTTP '+state.hold.httpStatus+'）；未自动重试。');
    if(new Set([...state.codes,...selected]).size>20)return publishStatus('failed','逐股公告核验每日最多20只；保留上次成功结果。');
    const byCode=Object.fromEntries(Object.entries(previous?.byCode||{}).filter(([code])=>permitted.has(code)).map(([code,rows])=>[code,rows.map(row=>({...row}))]));
    const found=new Map(Object.values(byCode).flat().map(row=>[row.code+':'+row.id,row]));
    const since=previous?.status==='partial'&&previous.coverage?.since?previous.coverage.since:new Date(Date.parse((previous?.checkedAt?localDay(Date.parse(previous.checkedAt)):day)+'T00:00:00Z')-(previous?86400000:30*86400000)).toISOString().slice(0,10);
    const coverage={since,through:day,scope:'bounded_public_queries_not_full_market',selectedCodeCount:selected.length,queries:[],errors:[]};
    async function fetchPage(searchkey,pageNum){
      const gap=Math.max(1500,interval)-(now()-state.lastRequestAt);if(gap>0)await wait(gap);
      state.lastRequestAt=now();await atomicJson(join(root,'state.json'),state);
      const body=new URLSearchParams({searchkey,sdate:since,edate:day,isfulltext:'false',sortName:'pubdate',sortType:'desc',pageNum:String(pageNum)});
      let response;
      try{response=await request(endpoint,{method:'POST',body,redirect:'error',signal:AbortSignal.timeout(20000)});}catch{throw failure('network','公开公告网络请求失败或超时；保留上次成功结果。');}
      if([401,403,418,429,451].includes(response.status)){
        state.hold={httpStatus:response.status,heldAt:stamp(now),retryAfter:response.headers.get('retry-after')};await atomicJson(join(root,'state.json'),state);
        throw failure('held','公开公告来源拒绝或限流（HTTP '+response.status+'）；已暂停后续请求。');
      }
      if(!response.ok)throw failure('http','公开公告 HTTP '+response.status+'；保留上次成功结果。');
      let payload;try{payload=await response.json();}catch{throw failure('invalid_json','公开公告响应不是有效JSON；保留上次成功结果。');}
      return parsePage(payload);
    }
    function accept(page,expectedCode,seen){
      let accepted=0;
      for(const raw of page.announcements){
        const key=raw.secCode+':'+raw.announcementId;
        if(seen.has(key))throw failure('duplicate_page','公告分页重复返回相同记录，未发布本轮结果。');seen.add(key);
        const record=parseAnnouncement(raw,{allowedUniverse:permitted,firstSeenAt:stamp(now),now,expectedCode});if(!record)continue;
        if(record.sourceDate<since||record.sourceDate>day)throw failure('source_day_mismatch','公告返回日期不在本轮查询范围内。');
        const identity=record.code+':'+record.id,prior=found.get(identity);if(prior)record.firstSeenAt=prior.firstSeenAt;
        found.set(identity,record);
        accepted++;
      }
      return accepted;
    }
    function queryResult(query,error){
      if(error&&!partialPageErrors.has(error.code))throw error;
      const result={scope:query.scope,query:query.searchkey,...(query.code?{code:query.code}:{}),status:error?'partial':'complete',pages:query.pages,expectedTotal:query.total,lastReportedTotal:query.lastTotal??null,rawRecordsSeen:query.seen.size,verifiedRecords:query.accepted};
      if(error){const issue={scope:query.scope,query:query.searchkey,...(query.code?{code:query.code}:{}),page:query.page,errorCode:error.code,reason:error.publicReason};coverage.errors.push(issue);Object.assign(result,{errorCode:error.code,reason:error.publicReason});}
      coverage.queries.push(result);
    }
    async function queryPage(query){
      query.pages++;const page=await fetchPage(query.searchkey,query.page);query.lastTotal=page.totalAnnouncement;
      if(query.total===null)query.total=page.totalAnnouncement;
      if(page.totalAnnouncement!==query.total)throw failure('changed_page','公告分页总数在读取中改变；只保留已逐条校验的记录，未宣称本查询完整。');
      query.accepted+=accept(page,query.code,query.seen);
      if(!page.hasMore&&query.seen.size!==query.total)throw failure('incomplete_page','公告分页数量不完整；只保留已逐条校验的记录，未宣称本查询完整。');
      return page.hasMore;
    }
    if(discover){
      const queries=keywords.map(searchkey=>({scope:'discovery',searchkey,page:1,pages:0,seen:new Set(),total:null,accepted:0}));
      for(let pages=0;pages<3&&queries.length;pages++){
        const query=queries.shift();
        try{if(await queryPage(query)){query.page++;queries.push(query);}else queryResult(query);}catch(error){queryResult(query,error);}
      }
      coverage.discoveryLimited=queries.length>0;
      for(const query of queries)queryResult(query,failure('page_limit','本轮为最多3页的限量公告发现，未宣称全市场或本查询完整覆盖。'));
    }
    for(const code of selected){
      if(!state.codes.includes(code)){state.codes.push(code);await atomicJson(join(root,'state.json'),state);}
      const query={scope:'selected',code,searchkey:code.slice(0,6),page:1,pages:0,seen:new Set(),total:null,accepted:0};let complete=false;
      try{
        for(let number=1;number<=3;number++){
          query.page=number;if(!await queryPage(query)){complete=true;break;}
        }
        if(!complete)throw failure('page_limit','单股公告超过3页；只保留已逐条校验的记录，未宣称本证券完整核验。');
        queryResult(query);
      }catch(error){queryResult(query,error);}
    }
    const combined={};for(const row of found.values())(combined[row.code]||=[]).push(row);
    for(const rows of Object.values(combined))rows.sort((a,b)=>b.sourceDate.localeCompare(a.sourceDate)||b.id.localeCompare(a.id,undefined,{numeric:true}));
    const checkedAt=stamp(now),status=coverage.errors.length?'partial':'complete',result={status,checkedAt,sourceId,byCode:combined,coverage,...(status==='partial'?{reason:'部分公告查询分页不完整；展示已逐条校验及历史保留的记录，不代表完整覆盖。'+(coverage.discoveryLimited?'本轮为最多3页的限量公告发现，未宣称全市场覆盖。':'')}:{})};
    const folder=join(root,day);await mkdir(folder,{recursive:true});
    const file=day+'/'+checkedAt.replace(/[:.]/g,'-')+'.json',body=JSON.stringify(result);
    await atomic(join(root,file),body);await atomic(join(root,file+'.gz'),gzipSync(body));
    await atomicJson(join(root,'status.json'),{status,checkedAt,sourceId,...(result.reason?{reason:result.reason}:{})});await atomicJson(join(root,'current.json'),{sourceId,file});
    return result;
  }catch(error){return publishStatus(error.code==='held'?'held':'failed',error.publicReason||'公开公告处理或存档失败；保留上次成功结果。');}
  finally{await unlink(lock);}
}
