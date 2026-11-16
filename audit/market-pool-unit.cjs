'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {build,select,chains} = require('../screening/market-pool.js');

function snapshot() {
  const stocks = Array.from({length:5000}, (_,i) => {
    const exchange = ['SH','SZ','BJ'][i%3];
    return {code:String(i).padStart(6,'0')+'.'+exchange,exchange,name:'测试'+i,
      boardName:'',price:9,changePct:0,totalMarketCap:null};
  });
  return {stocks,stockCount:stocks.length,updatedAt:'2025-12-31T16:12:00Z'};
}

test('requires the full validated universe and normalizes dated, equally weighted sector breadth', () => {
  const data = snapshot();
  assert.throws(()=>build({...data,stockCount:1}),/覆盖|记录数/);
  Object.assign(data.stocks[0],{boardName:' 数据 ',name:'数 据',changePct:10,totalMarketCap:0});
  Object.assign(data.stocks[1],{boardName:'数据',changePct:-4,totalMarketCap:100e8});
  Object.assign(data.stocks[2],{boardName:'数据',changePct:0,totalMarketCap:'0'});
  Object.assign(data.stocks[3],{boardName:'材料',changePct:9,totalMarketCap:-10});
  Object.assign(data.stocks[4],{boardName:'材料',price:0,changePct:100});
  const {day,rows,sectors} = build(data);
  assert.equal(day,'2026-01-01');
  assert.equal(rows.length,4999);
  assert.equal(rows[0].name,'数据');
  assert.deepEqual(rows.slice(0,4).map(r=>r.totalMarketCap),[0,100e8,null,null]);
  assert.equal(rows.at(-1).sector,'未分类');
  assert.deepEqual(sectors,[
    {name:'材料',count:1,up:1,down:0,flat:0,meanChange:9},
    {name:'数据',count:3,up:1,down:1,flat:1,meanChange:2},
  ]);
});

test('cap bounds use 亿元, distinguish missing from zero and preserve unfiltered rows', () => {
  const raw=snapshot();
  raw.stocks[0].totalMarketCap=0;
  raw.stocks[1].totalMarketCap=0.5e8;
  const rows=build(raw).rows.slice(0,3);
  const codes=opts=>select(rows,opts).map(r=>r.code);
  assert.deepEqual(codes({minCap:null,maxCap:null}),rows.map(r=>r.code));
  assert.deepEqual(codes({maxCap:0}),[rows[0].code]);
  assert.deepEqual(codes({minCap:0,maxCap:0.5}),[rows[0].code,rows[1].code]);
  assert.deepEqual(codes({minCap:0.5,maxCap:0.5}),[rows[1].code]);
});

test('curated industry chain membership intersects current rows, sector, venue and saved selections', () => {
  const chip=chains.find(c=>c.name==='半导体');
  assert.equal(chip.codes.length,15);
  assert.equal(chip.segments.length,3);
  assert.ok(chip.codes.includes('688256.SH'));
  assert.equal(chains.find(c=>c.name==='创新药').codes.length,14);
  for (const chain of chains) {
    assert.ok(chain.codes.every(code=>/^\d{6}\.(SH|SZ|BJ)$/.test(code)));
    assert.deepEqual(chain.codes,[...new Set(chain.segments.flatMap(s=>s.codes))]);
  }

  const common={exchange:'SH',totalMarketCap:1e8,price:20,sector:'电子',changePct:0};
  const rows=[
    {...common,code:'688256.SH',name:'寒武纪',changePct:2},
    {...common,code:'688981.SH',name:'中芯国际',changePct:2},
    {...common,code:'002371.SZ',name:'北方华创',exchange:'SZ',changePct:-1},
    {...common,code:'000858.SZ',name:'五粮液',exchange:'SZ',sector:'食品饮料',changePct:9}
  ];
  const filter={chain:'半导体',sector:'电子',venue:'SH',minChange:0,maxChange:2};
  assert.deepEqual(select(rows,filter).map(r=>r.code),['688256.SH','688981.SH']);
  assert.deepEqual(select(rows,{...filter,onlySaved:true,saved:new Set(['688981.SH'])}),[rows[1]]);
  assert.deepEqual(select(rows,{...filter,query:'中芯'}),[rows[1]]);
  assert.deepEqual(select(rows,{query:'688256.sh'}),[rows[0]]);
  assert.deepEqual(select(rows,{chain:'不存在'}),[]);
  assert.deepEqual(select(rows,{onlySaved:true,saved:new Set()}),[]);
  assert.deepEqual(select(rows,{maxChange:0}),[rows[2]]);
  assert.equal(select(rows,{})[0].code,'000858.SZ');
  assert.equal(rows[0].code,'688256.SH','source order unchanged');
});

 test('main-board name filter does not infer final eligibility from prices or code prefixes',()=>{
  const base={price:10,changePct:2,totalMarketCap:1e8,sector:'电子'};
  const rows=[['600519.SH','贵州茅台'],['002594.SZ','比亚迪'],['003000.SZ','普通样本'],['688001.SH','科创样本'],['300750.SZ','创业样本'],['920001.BJ','北交样本'],['900001.SH','B股'],['600001.SH','*ST样本'],['000002.SZ','S ST样本'],['600003.SH','样本退']].map(([code,name])=>({...base,code,name,exchange:code.split('.')[1]}));
  assert.deepEqual(select(rows,{universe:'main',excludeRiskNames:true}).map(r=>r.code),['002594.SZ','003000.SZ','600519.SH']);
  assert.equal(select(rows,{universe:'all',excludeRiskNames:true}).length,7);
  assert.equal(select(rows,{universe:'main',excludeRiskNames:true,query:'ST'}).length,0);
  assert.ok(select(rows,{universe:'main',excludeRiskNames:true}).every(r=>r.qualified===undefined));
 });
