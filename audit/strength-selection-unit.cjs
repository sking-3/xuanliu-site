'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const engine=require('../screening/trend-screen.js'),patterns=require('../screening/trend-patterns.js'),selection=require('../screening/strength-selection.js');
const day='2026-11-20',lookback=20,mode='consensus';
function record(index,sector='行业甲',values={}){
 return {stock:{code:String(600000+index)+'.SH',sector},result:{status:'ready',eligible:true,candidateMatched:true,directionMatched:true,excluded:false,matched:true,metrics:{startAt:'2026-10-23',endAt:day,sampleCount:21,relativeBaseline:'full_market_leave_one_out_equal_stock_daily_median',periodReturn:index,volumeRatio:1+index/10,excessReturn:index,recentExcessReturn:index,relativeStrengthChange:index,downsideExcess:1,downsideDays:2,...values}}};
}
function shape(row,matched=true){
 row.patterns={version:patterns.version,day,lookback,status:'ready',labels:matched?[{id:'trend-up'}]:[],unavailable:[],facts:{version:patterns.version,day,lookback,status:'ready'}};return row;
}
const select=(records,options={})=>selection.select(records,{day,lookback,mode,...options});
const peer={enabled:true,minPeers:2,groupTopPercent:100,minExcessReturn:-100,minRecentExcess:-100,minImprovement:-100};
test('browser and CommonJS share one pure selector without external data requests',()=>{
 const scope={BooksTrendScreen:engine,BooksTrendPatterns:patterns};vm.runInNewContext(fs.readFileSync(require.resolve('../screening/strength-selection.js'),'utf8'),scope);
 assert.equal(typeof scope.BooksStrengthSelection.select,'function');assert.doesNotMatch(fs.readFileSync(require.resolve('../screening/strength-selection.js'),'utf8'),/\bfetch\s*\(|XMLHttpRequest|WebSocket/);
 assert.deepEqual(JSON.parse(JSON.stringify(scope.BooksStrengthSelection.select([record(0)],{day,lookback,mode}))),select([record(0)]));
});
test('disabled peer rules preserve strict and observation membership without adding heat exclusions',()=>{
 const rows=Array.from({length:5},(_,i)=>record(i));rows[0].result.matched=false;rows[1].result.excluded=true;rows[2].result.eligible=false;rows[3].result.directionMatched=false;rows[4].result.status='unavailable';
 const before=JSON.stringify(rows),strict=select(rows),observation=select(rows,{qualification:'observation'});
 assert.deepEqual(strict.records.map(row=>row.selection.selected),[false,true,true,true,null]);
 assert.deepEqual(observation.records.map(row=>row.selection.selected),[true,true,true,false,null]);assert.equal(JSON.stringify(rows),before);
 assert(strict.records.every(row=>row.result.relativeStrength===null));assert.equal(strict.groupSummary.status,'disabled');
});
test('missing source, missing candidate and unknown strength remain unknown rather than confirmed exits',()=>{
 const rows=[record(0),record(1),record(2)];rows[0].result.status='unavailable';rows[1].result.candidateMatched=null;rows[2].result.strengthKnown=false;
 for(const options of [{},{peer}])assert(select(rows,options).records.every(row=>row.selection.selected===null));
});
test('selected shape requires current version and same-day same-window facts',()=>{
 const rows=Array.from({length:6},(_,i)=>shape(record(i)));rows[1].patterns.day='2026-11-19';rows[2].patterns.lookback=60;rows[3].patterns.facts.version='old';rows[4].patterns.unavailable=[{id:'trend-up'}];delete rows[5].patterns.facts;
 assert.deepEqual(select(rows,{patternId:'trend-up'}).records.map(row=>row.selection.selected),[true,null,null,null,null,null]);
 assert.equal(select([shape(record(8),false)],{patternId:'trend-up'}).records[0].selection.selected,false);
});
test('shape and direction select the whole candidate group before relative ranks',()=>{
 const rows=Array.from({length:8},(_,i)=>shape(record(i),i<4));rows[3].result.directionMatched=false;rows[0].result.matched=false;
 const output=select(rows,{patternId:'trend-up',qualification:'observation',peer});
 assert.equal(output.groupSummary.groupCount,3);assert.deepEqual(output.selectedRecords.map(row=>row.stock.code),rows.slice(0,3).map(row=>row.stock.code));
 assert.equal(output.records[0].result.matched,false);assert.equal(output.records[0].result.relativeStrength.rank,3);
 for(const row of output.records.slice(3))assert.equal(row.selection.selected,false);
});
test('enabled peers exclude overheated and ineligible rows without changing original rule outcomes',()=>{
 const rows=Array.from({length:5},(_,i)=>record(i));rows[3].result.excluded=true;rows[4].result.eligible=false;
 const before=JSON.stringify(rows),output=select(rows,{qualification:'observation',peer});
 assert.equal(output.groupSummary.groupCount,3);assert.deepEqual(output.records.map(row=>row.selection.selected),[true,true,true,false,false]);assert.equal(JSON.stringify(rows),before);
 assert(output.records.every(row=>row.result.matched===true));
});
test('missing fixed-market facts and mismatched windows cannot become false exits or enter ranks',()=>{
 const rows=Array.from({length:4},(_,i)=>record(i));delete rows[2].result.metrics.relativeBaseline;rows[3].result.metrics.sampleCount=61;
 const output=select(rows,{peer});assert.equal(output.groupSummary.groupCount,2);assert.deepEqual(output.records.map(row=>row.selection.selected),[true,true,null,null]);
 const short=select(rows,{peer:{...peer,minPeers:3}});assert(short.records.every(row=>row.selection.selected===null));
});
test('sector heat uses the complete same-window input independently of shape membership',()=>{
 const rows=[...Array.from({length:3},(_,i)=>shape(record(i,'行业甲',{periodReturn:i+1,volumeRatio:i+1}),i===0)),...Array.from({length:3},(_,i)=>shape(record(i+3,'行业乙',{periodReturn:-i-1,volumeRatio:1}),i===0))];
 const output=select(rows,{patternId:'trend-up',peer}),sectors=output.sectors;
 assert.equal(sectors.length,2);assert.equal(sectors[0].sector,'行业甲');assert.deepEqual(sectors[0].stats,{memberCount:3,totalCount:3,validCount:3,coverage:1,periodReturnMedian:2,upRatio:1,volumeRatioMedian:2,rank:1,percentile:100});
 assert.equal(sectors[1].stats.periodReturnMedian,-2);assert.equal(sectors[1].stats.upRatio,0);assert.equal(sectors[1].stats.rank,2);assert.equal(sectors[1].stats.percentile,0);
 assert.deepEqual(select(rows,{patternId:'',peer}).sectors,sectors);assert.match(sectors[0].reason,/盘后行业.*非题材/);
});
test('unknown, tiny and incomplete sectors stay unranked and cannot silently pass an enabled industry filter',()=>{
 const rows=[record(0,'未知'),record(1,'未知'),record(2,'未知'),record(3,'小行业'),record(4,'小行业'),record(5,'缺字段'),record(6,'缺字段'),record(7,'缺字段',{volumeRatio:null})];
 const output=select(rows,{peer:{...peer,sectorTopPercent:100}});assert(output.sectors.every(sector=>sector.status==='unavailable'&&sector.stats.rank===null));assert(output.records.every(row=>row.selection.selected===null));
 assert.equal(output.groupSummary.groupCount,0);assert(output.sectors.every(sector=>sector.stats.periodReturnMedian===null&&sector.stats.upRatio===null));
});
test('industry filtering occurs before peer ranks while its heat baseline stays fixed',()=>{
 const rows=[...Array.from({length:3},(_,i)=>record(i,'热行业',{periodReturn:5+i})),...Array.from({length:3},(_,i)=>record(i+3,'冷行业',{periodReturn:-i}))];
 const output=select(rows,{peer:{...peer,sectorTopPercent:50}});
 assert.equal(output.groupSummary.groupCount,3);assert.equal(output.sectors[0].stats.memberCount,3);assert.equal(output.sectors[1].stats.memberCount,3);
 assert.deepEqual(output.records.map(row=>row.selection.selected),[true,true,true,false,false,false]);assert.equal(output.records[2].result.relativeStrength.rank,1);
 assert.deepEqual(output.sectors,select(rows,{peer}).sectors);
});
test('industry boundary ties and peer boundary ties are order independent',()=>{
 const rows=Array.from({length:6},(_,i)=>record(i,i<3?'行业甲':'行业乙',{periodReturn:2,excessReturn:1,recentExcessReturn:1,relativeStrengthChange:1}));
 const options={peer:{...peer,groupTopPercent:1,sectorTopPercent:1}},a=select(rows,options),b=select(rows.slice().reverse(),options);
 assert.equal(a.selectedRecords.length,6);assert(a.sectors.every(sector=>sector.stats.rank===1&&sector.stats.percentile===50));
 assert.deepEqual(a.records.map(row=>row.selection),b.records.reverse().map(row=>row.selection));
});
test('duplicate stocks and invalid options fail instead of changing rank denominators',()=>{
 assert.throws(()=>select([record(0),record(0)]),/重复/);
 for(const options of [{day:'2026-02-30'},{lookback:5},{mode:'leader'},{qualification:'other'},{patternId:'missing'},{peer:null},{peer:{enabled:'true'}},{peer:{enabled:true,sectorTopPercent:0}},{peer:{enabled:true,sectorTopPercent:101}},{peer:{enabled:true,unknown:1}}])assert.throws(()=>select([record(0)],options));
});

test('a poorly covered sector cannot appear hot from only its remaining winners',()=>{
 const rows=Array.from({length:10},(_,i)=>record(i,'稀疏行业'));
 for(const row of rows.slice(3))row.result={status:'unavailable',matched:null,candidateMatched:null};
 const output=select(rows,{peer:{...peer,sectorTopPercent:100}}),sector=output.sectors[0];
 assert.equal(sector.status,'unavailable');assert.equal(sector.stats.coverage,.3);assert.equal(sector.stats.rank,null);
 assert.match(sector.reason,/覆盖不足80%/);assert(output.records.slice(0,3).every(row=>row.selection.selected===null));
});

test('scoping candidate stocks retains the fixed full industry reference',()=>{
 const all=Array.from({length:12},(_,i)=>record(i,i<6?'行业甲':'行业乙'));
 const full=select(all,{peer}),scoped=select(all.slice(0,4),{peer,sectorRecords:all});
 assert.deepEqual(scoped.sectors,full.sectors);assert.equal(scoped.groupSummary.groupCount,4);
 assert.throws(()=>select(all,{peer,sectorRecords:all.slice(0,3)}),/未覆盖/);
});
