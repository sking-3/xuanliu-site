import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,readdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gunzipSync} from 'node:zlib';
import {collectInstitutionDisclosures,readInstitutionDisclosures,parseAnnouncement,sourceId,directory,endpoint} from '../server/a-share-institution-disclosures.mjs';

const time=Date.parse('2026-11-25T08:30:00Z');
const universe=new Set(['600487.SH','600519.SH','002415.SZ']);
const row=(id='1225685853',day='2026-11-25',code='600487',title='亨通光电：首次实施回购公告')=>({secCode:code,announcementId:id,announcementTitle:title,announcementTime:Date.parse(day+'T00:00:00+08:00'),adjunctUrl:'finalpage/'+day+'/'+id+'.PDF'});
const page=(rows,hasMore=false,total=rows.length)=>Response.json({announcements:rows,totalAnnouncement:total,hasMore,totalpages:1});
async function fixture(t){const dataDir=await mkdtemp(join(tmpdir(),'books-institutions-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));return dataDir;}
const options=(dataDir,extra={})=>({dataDir,allowedUniverse:universe,selectedCodes:['600487.SH'],discover:false,now:()=>time,wait:async()=>{},fetch:async()=>page([row()]),...extra});
async function pointer(dataDir){return readFile(join(dataDir,directory,'current.json'),'utf8');}

// Minimal public metadata captured from the official anonymous query on 2026-11-25.
// Its two pages contain 10 + 7 rows while both incorrectly report totalpages=1.
const observed=[
  [
    "1225685853",
    "2026-11-25",
    "亨通光电：亨通光电关于首次实施回购公司股份的公告"
  ],
  [
    "1225682103",
    "2026-11-21",
    "亨通光电：亨通光电关于控股股东增持公司股份计划的进展公告"
  ],
  [
    "1225667515",
    "2026-11-12",
    "亨通光电：亨通光电关于与专业投资机构共同成立产业投资基金的公告"
  ],
  [
    "1225664373",
    "2026-11-10",
    "亨通光电：亨通光电关于召开2026年第三季度业绩说明会的提示性公告"
  ],
  [
    "1225664371",
    "2026-11-10",
    "亨通光电：亨通光电关于回购事项前十大股东和前十大无限售条件股东持股情况的公告"
  ],
  [
    "1225660612",
    "2026-11-06",
    "亨通光电：亨通光电关于控股股东获得增持专项贷款承诺函的公告"
  ],
  [
    "1225658263",
    "2026-11-05",
    "亨通光电：亨通光电薪酬与考核委员会关于公司2026年员工持股计划相关修订事项的审核意见"
  ],
  [
    "1225658272",
    "2026-11-05",
    "亨通光电：安徽承义律师事务所关于江苏亨通光电股份有限公司修订2026年员工持股计划相关事项的法律意见书"
  ],
  [
    "1225658269",
    "2026-11-05",
    "亨通光电：亨通光电关于公司2026年员工持股计划（草案）及相关文件的修订说明公告"
  ],
  [
    "1225658271",
    "2026-11-05",
    "亨通光电：亨通光电2026年员工持股计划草案修订稿摘要公告"
  ],
  [
    "1225658265",
    "2026-11-05",
    "亨通光电：亨通光电2026年员工持股计划（草案修订稿）"
  ],
  [
    "1225658264",
    "2026-11-05",
    "亨通光电：亨通光电2026年员工持股计划管理办法（修订稿）"
  ],
  [
    "1225658268",
    "2026-11-05",
    "亨通光电：申万宏源证券承销保荐有限责任公司关于江苏亨通光电股份有限公司2026年员工持股计划（草案修订稿）之独立财务顾问报告"
  ],
  [
    "1225658261",
    "2026-11-05",
    "亨通光电：亨通光电关于以集中竞价交易方式回购股份方案暨回购报告书"
  ],
  [
    "1225658270",
    "2026-11-05",
    "亨通光电：亨通光电第九届董事会第二十一次会议决议公告"
  ],
  [
    "1225658262",
    "2026-11-05",
    "亨通光电：亨通光电关于控股股东增持公司股份计划的公告"
  ],
  [
    "1225651028",
    "2026-11-02",
    "亨通光电：亨通光电关于公司董事长提议公司回购股份的提示性公告"
  ]
];
const observedRows=observed.map(([id,day,title])=>row(id,day,'600487',title));

test('the actual 17-row metadata fixture follows hasMore, verifies exact stock and total, and archives recoverable derived JSON',async t=>{
  const dir=await fixture(t),calls=[];
  const result=await collectInstitutionDisclosures(options(dir,{fetch:async(url,init)=>{
    assert.equal(url,endpoint);assert.equal(init.method,'POST');assert.equal(init.redirect,'error');assert.equal(init.headers,undefined);assert(init.signal instanceof AbortSignal);
    const body=new URLSearchParams(init.body);calls.push(Object.fromEntries(body));return page(calls.length===1?observedRows.slice(0,10):observedRows.slice(10),calls.length===1,17);
  }}));
  assert.equal(result.status,'complete');assert.equal(result.sourceId,sourceId);assert.deepEqual(calls.map(q=>q.pageNum),['1','2']);assert(calls.every(q=>q.searchkey==='600487'&&q.edate==='2026-11-25'));
  assert.equal(result.byCode['600487.SH'].length,17);assert.equal(new Set(result.byCode['600487.SH'].map(r=>r.id)).size,17);
  assert(result.byCode['600487.SH'].every(r=>r.publishedAt===null&&r.precision==='day'&&r.firstSeenAt===new Date(time).toISOString()));
  assert.equal(result.byCode['600487.SH'][1].kind,'shareholder_increase');assert.equal(result.byCode['600487.SH'][2].kind,'investment_fund_partnership');
  const saved=JSON.parse(await pointer(dir)),plain=await readFile(join(dir,directory,saved.file)),compressed=await readFile(join(dir,directory,saved.file+'.gz'));
  assert.deepEqual(gunzipSync(compressed),plain);assert.deepEqual(JSON.parse(plain),result);assert.deepEqual(await readInstitutionDisclosures({dataDir:dir}),result);
  assert.doesNotMatch(plain.toString(),/announcementTime|adjunctUrl|<em>|api.key|announcementContent/);
});

test('discovery rotates both official search terms across at most three pages and keeps only confirmed main-board memberships',async t=>{
  const dir=await fixture(t),calls=[];
  const result=await collectInstitutionDisclosures(options(dir,{selectedCodes:[],discover:true,fetch:async(url,init)=>{
    const body=new URLSearchParams(init.body);calls.push([body.get('searchkey'),body.get('pageNum')]);
    if(calls.length===1)return page([row('1','2026-11-25','600487','投资者关系活动记录表')],true,20);
    if(calls.length===2)return page([row('2','2026-11-25','688202','机构调研'),row('3','2026-11-25','600999','机构调研')],true,20);
    return page([row('4','2026-11-24','600519','机构调研活动记录')],true,20);
  }}));
  assert.equal(result.status,'partial');assert.deepEqual(calls,[['投资者关系活动记录表','1'],['机构调研','1'],['投资者关系活动记录表','2']]);assert.equal(result.coverage.errors.length,2);assert(result.coverage.errors.every(issue=>issue.errorCode==='page_limit'));
  assert.match(result.reason,/限量.*未宣称全市场/);
  assert.deepEqual(Object.keys(result.byCode).sort(),['600487.SH','600519.SH']);assert(Object.values(result.byCode).flat().every(r=>r.kind==='research_visit'&&r.summary.includes('不代表买入')));
  assert.doesNotMatch(JSON.stringify(result),/institutionalBuy|netBuy|持仓增加/);
});

test('missing or unconfirmed selected membership issues zero requests rather than guessing market coverage',async t=>{
  for(const changes of [{allowedUniverse:undefined},{selectedCodes:['688202.SH']},{selectedCodes:['600999.SH']}]){
    const dir=await fixture(t);let calls=0;
    const result=await collectInstitutionDisclosures(options(dir,{...changes,fetch:()=>{calls++;throw Error('must remain offline');}}));
    assert(['failed','unconfigured'].includes(result.status));assert.equal(calls,0);assert.deepEqual(result.byCode,{});
  }
});

test('midnight date labels remain day precision while an actual non-midnight field retains its publication time',()=>{
  const input={allowedUniverse:universe,firstSeenAt:new Date(time).toISOString(),now:()=>time};
  const daily=parseAnnouncement(row(),input);assert.equal(daily.sourceDate,'2026-11-25');assert.equal(daily.publishedAt,null);assert.equal(daily.precision,'day');
  const minute=parseAnnouncement({...row(),announcementTime:Date.parse('2026-11-25T14:02:00+08:00')},input);
  assert.equal(minute.publishedAt,'2026-11-25T06:02:00.000Z');assert.equal(minute.precision,'minute');
  assert.equal(parseAnnouncement(row('1','2026-11-25','688202'),input),null);
  assert.throws(()=>parseAnnouncement(row('1','2026-11-26'),input),/晚于/);
  assert.throws(()=>parseAnnouncement({...row(),announcementTime:time+1},input),/晚于/);
});

test('unsafe document addresses, misleading HTML and invalid identities cannot enter public summaries',()=>{
  const input={allowedUniverse:universe,firstSeenAt:new Date(time).toISOString(),now:()=>time};
  for(const adjunctUrl of ['https://evil.invalid/1.PDF','//static.cninfo.com.cn.evil.invalid/1.PDF','http://static.cninfo.com.cn/finalpage/2026-11-25/1.PDF','https://name@static.cninfo.com.cn/finalpage/2026-11-25/1.PDF','finalpage/2026-11-25/1.PDF?key=secret','finalpage/2026-11-25/1.PDF#fragment','finalpage/2026-11-25/1.html','../../1.PDF'])assert.throws(()=>parseAnnouncement({...row(),adjunctUrl},input),/地址/);
  const allowed=parseAnnouncement({...row(),adjunctUrl:'https://dataclouds.cninfo.com.cn/shgonggao/hsomarket/2026/20260506/official.PDF'},input);
  assert.equal(allowed.url,'https://dataclouds.cninfo.com.cn/shgonggao/hsomarket/2026/20260506/official.PDF');assert.equal(allowed.sourceDate,'2026-11-25','URL directory never manufactures the publication date');
  for(const changes of [{announcementTitle:'<script>wrong</script>'},{announcementId:'../1'},{secCode:'not-a-code'}])assert.throws(()=>parseAnnouncement({...row(),...changes},input));
});

test('firstSeenAt is the actual response observation and remains frozen on later discovery or enrichment',async t=>{
  const dir=await fixture(t);let clock=time;
  const first=await collectInstitutionDisclosures(options(dir,{now:()=>clock,fetch:async()=>{clock+=1000;return page([row()]);}}));
  assert.equal(first.byCode['600487.SH'][0].firstSeenAt,new Date(time+1000).toISOString());
  clock=time+3600000;
  const second=await collectInstitutionDisclosures(options(dir,{now:()=>clock,fetch:async()=>{clock+=1000;return page([row(),row('1225685854')]);}}));
  assert.equal(second.byCode['600487.SH'].find(r=>r.id==='1225685853').firstSeenAt,first.byCode['600487.SH'][0].firstSeenAt);
  assert.equal(second.byCode['600487.SH'].find(r=>r.id==='1225685854').firstSeenAt,new Date(clock).toISOString());
  assert.deepEqual(JSON.parse(await readFile(join(dir,directory,'state.json'))).codes,['600487.SH']);
});

test('HTTP, malformed, future and duplicate responses preserve exact last-success pointer and records',async t=>{
  const responses=[
    ()=>new Response('',{status:500}),
    ()=>new Response('not JSON'),
    ()=>page([row('1','2026-11-26')]),
    ()=>page([row(),row()]),
    ()=>Response.json({announcements:[],totalAnnouncement:1,hasMore:true})
  ];
  for(const response of responses){
    const dir=await fixture(t),good=await collectInstitutionDisclosures(options(dir)),before=await pointer(dir);let calls=0;
    const bad=await collectInstitutionDisclosures(options(dir,{now:()=>time+1000,fetch:async()=>{calls++;return response();}}));
    assert.equal(bad.status,'failed');assert.equal(calls,1);assert.equal(await pointer(dir),before);assert.deepEqual(bad.byCode,good.byCode);assert.deepEqual((await readInstitutionDisclosures({dataDir:dir})).byCode,good.byCode);
  }
});

test('a legitimate Hong Kong result in the real discovery query is filtered without breaking raw pagination counts',async t=>{
  const dir=await fixture(t),hk={...row('1225686000','2026-11-25','03969','中国通号：海外监管公告'),secName:'中国通号'};let calls=0;
  const result=await collectInstitutionDisclosures(options(dir,{selectedCodes:[],discover:true,fetch:async()=>{
    calls++;return calls===1?page([hk,row('1','2026-11-25','600487','投资者关系活动记录表')],false,2):page([]);
  }}));
  assert.equal(result.status,'complete');assert.equal(calls,2);assert.deepEqual(Object.keys(result.byCode),['600487.SH']);assert.equal(result.byCode['600487.SH'].length,1);
  assert.equal(parseAnnouncement(hk,{allowedUniverse:universe,firstSeenAt:new Date(time).toISOString(),now:()=>time}),null);
  assert.throws(()=>parseAnnouncement({...hk,secCode:'HK-03969'},{allowedUniverse:universe,now:()=>time}),/格式异常/);
});

test('a fuzzy stock query filters other valid issuers but counts their records before verifying complete pagination',async t=>{
  const dir=await fixture(t),wrong=row('2','2026-11-25','600519','其他发行人提及600487的公告');let calls=0;
  const result=await collectInstitutionDisclosures(options(dir,{fetch:async()=>{
    calls++;return calls===1?page([wrong],true,3):page([row(),row('3','2026-11-25','03969','海外监管公告')],false,3);
  }}));
  assert.equal(result.status,'complete');assert.equal(calls,2);assert.deepEqual(Object.keys(result.byCode),['600487.SH']);assert.equal(result.byCode['600487.SH'].length,1);assert.equal(result.byCode['600487.SH'][0].id,'1225685853');
});

test('401,403 and429 persist a source hold across normal scheduled calls and days without another request',async t=>{
  for(const status of [401,403,429]){
    const dir=await fixture(t),good=await collectInstitutionDisclosures(options(dir)),before=await pointer(dir);let calls=0;
    const input=options(dir,{now:()=>time+1000,fetch:async()=>{calls++;return new Response('provider raw text',{status,headers:{'Retry-After':'120'}});}});
    const failed=await collectInstitutionDisclosures(input),held=await collectInstitutionDisclosures({...input,now:()=>time+86400000});
    assert.equal(failed.status,'held');assert.equal(held.status,'held');assert.equal(calls,1);assert.deepEqual(held.byCode,good.byCode);assert.equal(await pointer(dir),before);
    const state=JSON.parse(await readFile(join(dir,directory,'state.json')));assert.equal(state.hold.httpStatus,status);assert.equal(state.hold.retryAfter,'120');assert.doesNotMatch(JSON.stringify(failed),/provider raw text/);
  }
});

test('the persisted twenty-code daily budget and minimum serial interval cannot be bypassed by another run',async t=>{
  const dir=await fixture(t),codes=Array.from({length:21},(_,i)=>String(600000+i)+'.SH');let clock=time,calls=0;const waits=[];
  const input=options(dir,{allowedUniverse:new Set(codes),selectedCodes:codes.slice(0,20),interval:0,now:()=>clock,wait:async ms=>{waits.push(ms);clock+=ms;},fetch:async()=>{calls++;return page([]);}});
  assert.equal((await collectInstitutionDisclosures(input)).status,'complete');assert.equal(calls,20);assert.equal(waits.length,19);assert(waits.every(ms=>ms===1500));
  assert.equal((await collectInstitutionDisclosures({...input,selectedCodes:[codes[20]]})).status,'failed');assert.equal(calls,20);
  clock=time+86400000;assert.equal((await collectInstitutionDisclosures({...input,selectedCodes:[codes[20]]})).status,'complete');assert.equal(calls,21);
});

test('nonprogressing duplicate pages fail globally, while capped unique pages retain explicitly partial verified records',async t=>{
  for(const repeated of [true,false]){
    const dir=await fixture(t),good=await collectInstitutionDisclosures(options(dir)),before=await pointer(dir);let calls=0;
    const result=await collectInstitutionDisclosures(options(dir,{now:()=>time+1000,fetch:async()=>{calls++;return page([row(repeated?'77':String(77+calls))],true,9);}}));
    assert.equal(calls,repeated?2:3);
    if(repeated){assert.equal(result.status,'failed');assert.equal(await pointer(dir),before);assert.deepEqual(result.byCode,good.byCode);}
    else{assert.equal(result.status,'partial');assert.equal(result.byCode['600487.SH'].length,4);assert(result.byCode['600487.SH'].some(record=>record.id===good.byCode['600487.SH'][0].id));assert.equal(result.coverage.queries[0].expectedTotal,9);assert.equal(result.coverage.queries[0].rawRecordsSeen,3);assert.equal(result.coverage.errors[0].errorCode,'page_limit');}
  }
});

test('a failed multi-stock run cannot mark unpublished records as permanently completed',async t=>{
  const dir=await fixture(t);let failSecond=true;
  const input=options(dir,{selectedCodes:['600487.SH','600519.SH'],fetch:async(url,init)=>{
    const code=new URLSearchParams(init.body).get('searchkey');if(code==='600519'&&failSecond)return new Response('',{status:500});
    return page([row(code==='600487'?'1':'2','2026-11-25',code)]);
  }});
  assert.equal((await collectInstitutionDisclosures(input)).status,'failed');failSecond=false;
  const recovered=await collectInstitutionDisclosures({...input,now:()=>time+1000});assert.equal(recovered.status,'complete');assert.deepEqual(Object.keys(recovered.byCode).sort(),['600487.SH','600519.SH']);
});

test('another active producer cannot spend the same budget or move the published pointer',async t=>{
  const dir=await fixture(t);await collectInstitutionDisclosures(options(dir));const before=await pointer(dir);
  await writeFile(join(dir,directory,'worker.lock'),String(process.pid));let calls=0;
  const result=await collectInstitutionDisclosures(options(dir,{fetch:()=>{calls++;throw Error('no second worker');}}));
  assert.equal(result.status,'running');assert.equal(calls,0);assert.equal(await pointer(dir),before);assert((await readdir(join(dir,directory))).includes('worker.lock'));
});

test('a supposedly finished discovery page remains incomplete and never clears old records or claims coverage',async t=>{
  const dir=await fixture(t),good=await collectInstitutionDisclosures(options(dir)),before=await pointer(dir);
  const result=await collectInstitutionDisclosures(options(dir,{selectedCodes:[],discover:true,now:()=>time+1000,fetch:async()=>page([],false,17)}));
  assert.equal(result.status,'partial');assert.notEqual(await pointer(dir),before);assert.deepEqual(result.byCode,good.byCode);assert.equal(result.coverage.errors.length,2);assert(result.coverage.queries.every(query=>query.expectedTotal===17&&query.rawRecordsSeen===0&&query.status==='partial'&&query.errorCode==='incomplete_page'));
});

test('a crashed producer lock is recovered only after its owner is confirmed absent',async t=>{
  const dir=await fixture(t);await collectInstitutionDisclosures(options(dir));
  await writeFile(join(dir,directory,'worker.lock'),'2147483647');
  t.mock.method(process,'kill',(pid,signal)=>{assert.equal(pid,2147483647);assert.equal(signal,0);throw Object.assign(Error('absent'),{code:'ESRCH'});});
  const recovered=await collectInstitutionDisclosures(options(dir,{now:()=>time+1000}));assert.equal(recovered.status,'complete');assert(!(await readdir(join(dir,directory))).includes('worker.lock'));
});

test('the real sixteen-to-null-zero second-page failure retains validated discovery, selected and historical records with partial coverage',async t=>{
  const dir=await fixture(t),old=await collectInstitutionDisclosures(options(dir)),calls=[],partialRows=Array.from({length:10},(_,i)=>row(String(100+i),'2026-11-25','600519','机构调研记录'));
  const result=await collectInstitutionDisclosures(options(dir,{selectedCodes:['600519.SH','600487.SH'],discover:true,now:()=>time+1000,fetch:async(url,init)=>{
    const body=new URLSearchParams(init.body),query=body.get('searchkey'),number=body.get('pageNum');calls.push([query,number]);
    if(query==='投资者关系活动记录表')return page([row('900','2026-11-25','002415','投资者关系活动记录表')]);
    if(query==='机构调研')return page([]);
    if(query==='600519')return number==='1'?page(partialRows,true,16):Response.json({totalAnnouncement:0,announcements:null,hasMore:false,totalpages:0});
    return page([row('901')]);
  }}));
  assert.equal(result.status,'partial');assert.deepEqual(calls,[['投资者关系活动记录表','1'],['机构调研','1'],['600519','1'],['600519','2'],['600487','1']]);
  assert.equal(result.byCode['600519.SH'].length,10);assert.equal(result.byCode['002415.SZ'][0].id,'900');assert.deepEqual(new Set(result.byCode['600487.SH'].map(record=>record.id)),new Set(['1225685853','901']));assert.equal(result.byCode['600487.SH'].find(record=>record.id==='1225685853').firstSeenAt,old.byCode['600487.SH'][0].firstSeenAt);
  const query=result.coverage.queries.find(query=>query.code==='600519.SH');assert.deepEqual(query,{scope:'selected',query:'600519',code:'600519.SH',status:'partial',pages:2,expectedTotal:16,lastReportedTotal:0,rawRecordsSeen:10,verifiedRecords:10,errorCode:'changed_page',reason:query.reason});assert.match(query.reason,/总数.*改变/);assert.equal(result.coverage.errors.length,1);assert.equal(result.coverage.queries.find(query=>query.code==='600487.SH').status,'complete');assert.match(result.reason,/不代表完整覆盖/);
  assert.deepEqual(await readInstitutionDisclosures({dataDir:dir}),result);const saved=JSON.parse(await pointer(dir)),plain=await readFile(join(dir,directory,saved.file));assert.deepEqual(gunzipSync(await readFile(join(dir,directory,saved.file+'.gz'))),plain);assert.equal(JSON.parse(plain).status,'partial');
});

test('an honest null-zero terminal page is empty, while malformed list pagination is explicitly partial and other stocks continue',async t=>{
  const dir=await fixture(t),old=await collectInstitutionDisclosures(options(dir));let requests=0;
  const empty=await collectInstitutionDisclosures(options(dir,{now:()=>time+1000,fetch:async()=>Response.json({announcements:null,totalAnnouncement:0,hasMore:false,totalpages:0})}));assert.equal(empty.status,'complete');assert.equal(empty.coverage.queries[0].rawRecordsSeen,0);assert.deepEqual(empty.byCode,old.byCode);
  const result=await collectInstitutionDisclosures(options(dir,{selectedCodes:['600519.SH','600487.SH'],now:()=>time+2000,fetch:async(url,init)=>{
    requests++;return new URLSearchParams(init.body).get('searchkey')==='600519'?Response.json({announcements:'invalid',totalAnnouncement:1,hasMore:false}):page([row('902')]);
  }}));assert.equal(requests,2);assert.equal(result.status,'partial');assert.equal(result.coverage.errors[0].errorCode,'invalid_page');assert.equal(result.coverage.queries[0].expectedTotal,null);assert.equal(result.byCode['600487.SH'].length,2);assert.equal(result.byCode['600519.SH'],undefined);
});

test('a partial checkpoint keeps its unresolved query window for recovery and preserves the original first-seen timestamps',async t=>{
  const dir=await fixture(t),rows=Array.from({length:16},(_,i)=>row(String(1000+i)));let calls=0;
  const partial=await collectInstitutionDisclosures(options(dir,{fetch:async()=>{calls++;return calls===1?page(rows.slice(0,10),true,16):Response.json({announcements:null,totalAnnouncement:0,hasMore:false});}}));assert.equal(partial.status,'partial');assert.equal(partial.coverage.since,'2026-10-26');
  const requests=[];
  const recovered=await collectInstitutionDisclosures(options(dir,{now:()=>time+86400000,fetch:async(url,init)=>{
    const body=new URLSearchParams(init.body);requests.push(Object.fromEntries(body));return body.get('pageNum')==='1'?page(rows.slice(0,10),true,16):page(rows.slice(10),false,16);
  }}));assert.equal(recovered.status,'complete');assert.equal(recovered.byCode['600487.SH'].length,16);assert(requests.every(query=>query.sdate===partial.coverage.since&&query.edate==='2026-11-26'));assert.equal(recovered.byCode['600487.SH'].find(record=>record.id==='1000').firstSeenAt,partial.byCode['600487.SH'].find(record=>record.id==='1000').firstSeenAt);assert.equal(recovered.byCode['600487.SH'].find(record=>record.id==='1015').firstSeenAt,new Date(time+86400000).toISOString());
});

test('record identity, links, network failures and auth refusal still roll back all newly collected rows, even after a valid query',async t=>{
  for(const failure of ['identity','url','network','held']){
    const dir=await fixture(t),old=await collectInstitutionDisclosures(options(dir)),before=await pointer(dir);let calls=0;
    const result=await collectInstitutionDisclosures(options(dir,{selectedCodes:['600519.SH','600487.SH'],now:()=>time+1000,fetch:async(url,init)=>{
      calls++;if(new URLSearchParams(init.body).get('searchkey')==='600519')return page([row('910','2026-11-25','600519')]);
      if(failure==='network')throw Error('private network failure text');if(failure==='held')return new Response('private denial',{status:403});
      return page([{...row('911'),...(failure==='identity'?{announcementId:'wrong'}:{adjunctUrl:'https://evil.invalid/1.pdf'})}]);
    }}));assert.equal(result.status,failure==='held'?'held':'failed');assert.equal(calls,2);assert.equal(await pointer(dir),before);assert.deepEqual(result.byCode,old.byCode);assert.equal(result.byCode['600519.SH'],undefined);assert.doesNotMatch(JSON.stringify(result),/private network failure text|private denial/);
  }
});

