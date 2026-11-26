import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {evaluateCompany,evaluateEtf,parseCikMap,parseReferenceUniverse,parseEtfDocument,collectFundamentals} from '../server/us-fundamentals.mjs';

const timestamp=Date.parse('2026-11-26T01:00:00Z');
const config=JSON.parse(await readFile(new URL('../research-data/us-fundamental-universe.json',import.meta.url),'utf8'));
const parameters=config.parameters;
const million=1000000;
function fact(value,start,end,filed='2026-11-01',form='10-K') {return {start,end,val:value,filed,form,accn:'0000001001-26-000001'};}
function fixture(symbol='AAA',cik='0000001001') {
  const gaap={};
  const annual={Revenues:[1000,1100,1200,1300,1400],NetIncomeLoss:[100,110,120,130,140],NetCashProvidedByUsedInOperatingActivities:[200,220,240,260,280],PaymentsToAcquirePropertyPlantAndEquipment:[50,55,60,65,70]};
  for(const [tag,values] of Object.entries(annual))gaap[tag]={units:{USD:values.map((value,index)=>fact(value*million,(2021+index)+'-01-01',(2021+index)+'-12-31'))}};
  for(const [tag,current,previous] of [['Revenues',1200,1050],['NetIncomeLoss',120,105],['NetCashProvidedByUsedInOperatingActivities',240,210],['PaymentsToAcquirePropertyPlantAndEquipment',60,52.5]])gaap[tag].units.USD.push(fact(current*million,'2026-01-01','2026-09-30','2026-11-01','10-Q'),fact(previous*million,'2025-01-01','2025-09-30','2026-11-01','10-Q'));
  gaap.WeightedAverageNumberOfDilutedSharesOutstanding={units:{shares:[2021,2022,2023,2024,2025].map(year=>fact(100*million,year+'-01-01',year+'-12-31'))}};
  for(const [tag,value] of [['CashAndCashEquivalentsAtCarryingValue',50],['DebtCurrent',10],['LongTermDebtNoncurrent',30]])gaap[tag]={units:{USD:[{val:value*million,end:'2026-09-30',filed:'2026-11-01',form:'10-Q'}]}};
  const facts={cik:Number(cik),facts:{'us-gaap':gaap,dei:{EntityCommonStockSharesOutstanding:{units:{shares:[{val:100*million,end:'2026-10-20',filed:'2026-11-01',form:'10-Q'}]}}}}};
  const submissions={cik,name:'Synthetic '+symbol,tickers:[symbol],sic:'3571',filings:{recent:{accessionNumber:['0000001001-26-000001'],form:['10-Q'],filingDate:['2026-11-01'],acceptanceDateTime:['2026-11-01T12:00:00Z'],primaryDocument:['report.htm']}}};
  return {stock:{symbol,name:'Synthetic '+symbol,cik,industry:'Industrials'},facts,submissions,price:{close:10,asOf:'2026-11-25T21:00:00Z',sourceId:'synthetic-offline',permissionsVerified:true,derivedPublic:true},now:timestamp,parameters,readAt:'2026-11-26T01:00:00Z'};
}

test('TTM uses annual + comparable YTD and three-year normalization; annual and YTD are not double-counted',()=>{
  const result=evaluateCompany(fixture()),row=result.fundamental;
  assert.equal(row.asOf,'2026-09-30');assert.equal(row.metrics.revenueTtm,1550*million);assert.equal(row.metrics.netIncomeTtm,155*million);assert.equal(row.metrics.fcfTtm,232.5*million);
  assert.equal(row.metrics.normalizedNetIncome,130*million);assert.equal(row.metrics.normalizedFcfYield,19.5);assert.equal(row.metrics.annualProfitYears,5);assert.equal(row.metrics.annualFcfYears,5);assert.equal(row.metrics.dilutionPct,0);
  assert.equal(row.status,'candidate');assert.equal(row.valuationStatus,'low_multiple');assert.equal(result.dca.status,'candidate');assert.equal(row.severelyUndervalued,false);
  assert.equal(row.valuationBasis.shareCountAsOf,'2026-10-20');assert.equal(row.valuationBasis.priceAsOf,'2026-11-25T21:00:00Z');assert.equal(row.valuationBasis.marketCapIsEstimate,true);
});

test('missing or private prices retain real financial results without manufacturing valuation',()=>{
  for(const change of [{price:null},{price:{...fixture().price,derivedPublic:false}},{price:{...fixture().price,asOf:'2026-11-01T21:00:00Z'}}]){
    const row=evaluateCompany({...fixture(),...change}).fundamental;
    assert.equal(row.financialPassed,true);assert.equal(row.status,'pending');assert.equal(row.valuationStatus,'pending');assert.equal(row.metrics.pe,null);assert(row.reasons.some(item=>item.code==='price_permission_or_freshness_pending'));
    assert.doesNotMatch(JSON.stringify(row),/"(?:close|apiKey|token|bars)":/);
  }
});

test('future filings and incomplete comparable periods cannot create a current passing result',()=>{
  const value=fixture();value.facts.facts['us-gaap'].NetIncomeLoss.units.USD.push(fact(9999*million,'2026-01-01','2026-09-30','2026-12-01','10-Q'));
  assert.equal(evaluateCompany(value).fundamental.metrics.netIncomeTtm,155*million);
  value.facts.facts['us-gaap'].NetCashProvidedByUsedInOperatingActivities.units.USD=value.facts.facts['us-gaap'].NetCashProvidedByUsedInOperatingActivities.units.USD.filter(row=>row.end!=='2025-09-30');
  const missing=evaluateCompany(value).fundamental;assert.equal(missing.metrics.fcfTtm,null);assert.equal(missing.financialPassed,false);assert.equal(missing.status,'pending');
});

test('losses, missing years, debt, dilution, share classes and post-price filings remain independent gates',()=>{
  const loss=fixture();loss.facts.facts['us-gaap'].NetIncomeLoss.units.USD.find(row=>row.end==='2024-12-31').val=-million;
  assert.equal(evaluateCompany(loss).fundamental.metrics.annualProfitYears,1);assert.equal(evaluateCompany(loss).dca.status,'pending');
  const gap=fixture();gap.facts.facts['us-gaap'].NetIncomeLoss.units.USD=gap.facts.facts['us-gaap'].NetIncomeLoss.units.USD.filter(row=>row.end!=='2024-12-31');
  assert.equal(evaluateCompany(gap).fundamental.metrics.annualProfitYears,1);
  const debt=fixture();debt.facts.facts['us-gaap'].DebtCurrent.units.USD[0].val=1000*million;assert(evaluateCompany(debt).fundamental.reasons.some(row=>row.code==='debt_above_limit'));
  const dilution=fixture();dilution.facts.facts['us-gaap'].WeightedAverageNumberOfDilutedSharesOutstanding.units.shares.at(-1).val=120*million;assert(evaluateCompany(dilution).fundamental.reasons.some(row=>row.code==='dilution_above_limit'));
  const classes=fixture();classes.submissions.tickers.push('AAB');assert.equal(evaluateCompany(classes).fundamental.metrics.pe,null);assert(evaluateCompany(classes).dca.reasons.some(row=>row.code==='share_class_pending'));
  const released=fixture();released.submissions.filings.recent.acceptanceDateTime[0]='2026-11-25T22:00:00Z';assert(evaluateCompany(released).fundamental.reasons.some(row=>row.code==='price_before_latest_filing'));
  const bank=fixture();bank.submissions.sic='6021';assert(evaluateCompany(bank).fundamental.reasons.some(row=>row.code==='sector_method_pending'));
});

test('absent short-term debt and missing capex are unknown, not zero',()=>{
  const value=fixture(),gaap=value.facts.facts['us-gaap'];gaap.LongTermDebtCurrent=gaap.DebtCurrent;delete gaap.DebtCurrent;
  const debt=evaluateCompany(value).fundamental;assert.equal(debt.metrics.netDebtToFcf,null);assert.equal(debt.financialPassed,false);
  delete gaap.PaymentsToAcquirePropertyPlantAndEquipment;assert.equal(evaluateCompany(value).fundamental.metrics.fcfTtm,null);
});

test('ticker/CIK mismatch stops before it can attach another company financials',()=>{
  const value=fixture();value.submissions.tickers=['OTHER'];const row=evaluateCompany(value).fundamental;
  assert.equal(row.financialPassed,false);assert.equal(row.status,'pending');assert.equal(row.reasons[0].code,'cik_symbol_mismatch');
});

test('ETF quality screening keeps holdings date separate from source check and does not promote failed checks',()=>{
  const metadata=config.etfs[0],base={now:timestamp,readAt:'2026-11-26T01:00:00Z',parameters,sourceCheck:{checkedAt:'2026-11-26T01:00:00Z'}};
  const row=evaluateEtf(metadata,base);assert.equal(row.status,'candidate');assert.equal(row.asOf,'2026-09-30');assert.equal(row.sourceTime,'2026-09-30');assert.equal(row.metrics.expenseRatio,.06);
  assert.equal(evaluateEtf({...metadata,leveraged:true},base).status,'pending');assert.equal(evaluateEtf(metadata,{...base,sourceCheck:{error:'HTTP 403'}}).status,'pending');assert.equal(evaluateEtf(metadata,{...base,sourceCheck:{changed:true}}).status,'pending');
  assert.equal(evaluateEtf(metadata,{...base,now:Date.parse('2027-03-01T00:00:00Z')}).status,'pending');
  assert.equal(evaluateEtf({...metadata,holdingsAsOf:'2026-12-31'},base).status,'pending');
});

test('issuer metadata parsing reads actual fee/holdings dates and updates rather than relabeling old seed data',()=>{
  const updated=parseEtfDocument('Vanguard Total World Stock ETF | VT As of December 31, 2026 Expense ratio 1 0.05% Number of stocks 10,200 10,300 Price/earnings ratio 21.2x Top ten as % of total net assets 24.3%',config.etfs[0]);
  assert.equal(updated.expenseRatio,.05);assert.equal(updated.holdingsCount,10200);assert.equal(updated.holdingsAsOf,'2026-12-31');assert.equal(updated.top10Weight,24.3);
  const schd=parseEtfDocument('<h1>SCHD</h1><td>Total Expense Ratio</td><td>0.060%</td><td>Total Holdings As of 11/25/2026</td><td>102</td><td>Price to Earnings Ratio As of 10/31/2026</td><td>18.51</td>',config.etfs[3]);
  assert.equal(schd.holdingsAsOf,'2026-11-25');assert.equal(schd.portfolioPeAsOf,'2026-10-31');assert.equal(schd.top10Weight,null);
  assert.throws(()=>parseEtfDocument('unrelated source',config.etfs[0]));
});

test('Vanguard real pdftotext footnote layout preserves the fund column and ignores expense comparisons',()=>{
  // VT official F3141.pdf extracted on the VPS: footnote 1 is attached to the label.
  const text='Vanguard Total World Stock ETF | VT\nAs of September 30, 2026\nExpense ratio comparison1\n0.84%\n0.06%\nQuick facts\nExpense ratio1                       0.06%\nNumber of stocks                    10,185 10,221\nPrice/earnings ratio                20.4x 20.4x\nTop ten as % of total net assets    23.5%';
  const actual=parseEtfDocument(text,config.etfs[0]);
  assert.equal(actual.expenseRatio,.06);assert.equal(actual.holdingsCount,10185);assert.equal(actual.holdingsAsOf,'2026-09-30');assert.equal(actual.portfolioPe,20.4);assert.equal(actual.top10Weight,23.5);
  const onlyComparison=text.replace('Expense ratio1                       0.06%','');
  assert.throws(()=>parseEtfDocument(onlyComparison,config.etfs[0]),/字段未核验/);
  for(const metadata of config.etfs.slice(1,3)){
    const row=parseEtfDocument(metadata.symbol+' As of September 30, 2026 Expense ratio1 0.03% Number of stocks '+metadata.holdingsCount+' 999 Price/earnings ratio 24.1x',metadata);
    assert.equal(row.expenseRatio,.03);assert.equal(row.holdingsCount,metadata.holdingsCount);
  }
});

function collectionSources() {
  const members=Array.from({length:80},(_,index)=>({symbol:'AAA'+index,cik:String(1001+index).padStart(10,'0')}));
  const csv='Fund Holdings as of,"Nov 24, 2026"\nTicker,Name,Sector,Asset Class,Price\n'+members.map(row=>[row.symbol,'Synthetic','Industrials','Equity','10'].join(',')).join('\n');
  const html='<table><tr><th>Symbol</th><th>Security</th><th>GICS Sector</th><th>CIK</th></tr>'+members.map(row=>'<tr><td>'+row.symbol+'</td><td>Synthetic</td><td>Industrials</td><td>'+row.cik+'</td></tr>').join('')+'</table>';
  return {members,csv,html};
}
test('objective universe parsing only takes equities and validates source/date/CIK columns',()=>{
  const data=collectionSources();assert.equal(parseReferenceUniverse(data.csv).members.length,80);assert.equal(parseCikMap(data.html).AAA0.cik,'0000001001');
  assert.throws(()=>parseReferenceUniverse(data.csv.replaceAll('Equity','Cash')));assert.throws(()=>parseCikMap('<table><tr><td>No identifiers</td></tr></table>'));
});

test('real collector path archives gzip, reuses unchanged facts, stops denied source once and retains last success',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'books-us-fundamental-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const data=collectionSources(),settings={...config,referenceSymbols:[],etfs:[config.etfs[3]]},prices=Object.fromEntries(data.members.map(row=>[row.symbol,fixture(row.symbol,row.cik).price]));
  let denied=false,secRequests=0,factRequests=0,laggedFacts=false;const progress=[];
  const request=async(url,options)=>{
    assert(options.headers['User-Agent']);
    if(url===settings.universeSource)return new Response(data.csv);
    if(url===settings.cikMapSource)return new Response(data.html);
    if(url===settings.etfs[0].sourceUrl)return new Response('SCHD Total Expense Ratio 0.060% Total Holdings As of 11/25/2026 102 Price to Earnings Ratio As of 10/31/2026 18.51');
    secRequests++;if(denied)return new Response('stopped',{status:403});
    const cik=url.match(/CIK(\d+)\.json/)[1],member=data.members.find(row=>row.cik===cik),value=fixture(member.symbol,cik);
    if(url.includes('companyfacts')){factRequests++;return new Response(JSON.stringify(value.facts));}
    if(laggedFacts&&member.symbol==='AAA0')value.submissions.filings.recent.accessionNumber[0]='0000001001-26-000002';
    return new Response(JSON.stringify(value.submissions));
  };
  const first=await collectFundamentals({directory:dir,config:settings,prices,now:timestamp,fetch:request,wait:async()=>{},onProgress:async value=>{progress.push(value);}});
  assert.equal(first.fundamentals.status,'ready');assert.equal(first.fundamentals.counts.lowMultiple,80);assert.equal(first.dca.rows.filter(row=>row.status==='candidate').length,81);assert.equal(factRequests,80);
  const successFile=join(dir,'fundamentals/private/last-success.json.gz'),stored=JSON.parse(gunzipSync(await readFile(successFile)));assert.equal(stored.fundamentals.rows.length,80);
  await collectFundamentals({directory:dir,config:settings,prices,now:timestamp+1000,fetch:request,wait:async()=>{}});assert.equal(factRequests,80);
  const before=await readFile(successFile);
  laggedFacts=true;
  const lagged=await collectFundamentals({directory:dir,config:settings,prices,now:timestamp+dayMs,fetch:request,wait:async()=>{}}),pending=lagged.fundamentals.rows.find(row=>row.symbol==='AAA0');
  assert.equal(pending.status,'pending');assert.equal(pending.valuationStatus,'pending');assert.equal(pending.asOf,'2026-09-30');assert(pending.reasons.some(row=>row.message.includes('尚未包含最新申报')));
  const cached=JSON.parse(gunzipSync(await readFile(join(dir,'fundamentals/private/facts-0000001001.json.gz'))));assert.equal(cached.accession,'0000001001-26-000001','lagging companyfacts must not be bound to a new accession');
  assert(before.equals(await readFile(successFile)),'lagging facts must preserve prior success');
  const previousSecRequests=secRequests;denied=true;
  const failed=await collectFundamentals({directory:dir,config:settings,prices,now:timestamp+dayMs*2,fetch:request,wait:async()=>{}});
  assert.equal(secRequests-previousSecRequests,1);assert.equal(failed.fundamentals.status,'partial');assert.equal(failed.fundamentals.rows.length,80);assert.equal(failed.fundamentals.rows[0].metrics.revenueTtm,1550*million);assert.equal(failed.fundamentals.rows[0].stale,true);
  const after=await readFile(successFile);assert(before.equals(after),'failed source must leave last-success archive unchanged');
  assert.equal(progress.at(-1).phase,'fundamentals_complete');assert.doesNotMatch(JSON.stringify(first),/"(?:close|open|high|low|volume|token|apiKey|bars)":/);
});

const dayMs=86400000;
