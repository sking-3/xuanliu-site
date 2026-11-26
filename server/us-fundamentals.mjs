import {mkdir, readFile, writeFile, rename} from 'node:fs/promises';
import {join} from 'node:path';
import {gzipSync, gunzipSync} from 'node:zlib';
import {setTimeout as sleep} from 'node:timers/promises';
import {spawnSync} from 'node:child_process';

export const schema = 'books.us.fundamentals.v1';
const dayMs = 86400000;
const configUrl = new URL('../research-data/us-fundamental-universe.json', import.meta.url);
const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString().slice(0,10)===value;
const normalizeSymbol = value => String(value || '').replace(/\.US$/, '').replace(/[ -]/g, '.').toUpperCase();
const median = values => {const sorted = [...values].sort((a,b) => a-b);return sorted.length ? (sorted[Math.floor((sorted.length-1)/2)]+sorted[Math.ceil((sorted.length-1)/2)])/2 : null;};
const ageDays = (value, now) => validDay(String(value).slice(0,10)) ? (now-Date.parse(String(value).slice(0,10)+'T00:00:00Z'))/dayMs : Infinity;
const issue = (code, message) => ({code,message});
function sourceDay(value) {
  if(validDay(value))return value;
  const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const named=String(value||'').match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/),numeric=String(value||'').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const parts=named?[Number(named[3]),months.indexOf(named[1].slice(0,3))+1,Number(named[2])]:numeric?[Number(numeric[3]),Number(numeric[1]),Number(numeric[2])]:null;
  const day=parts?parts[0]+'-'+String(parts[1]).padStart(2,'0')+'-'+String(parts[2]).padStart(2,'0'):null;
  return validDay(day)?day:null;
}
const moneyTags = {
  revenue:['RevenueFromContractWithCustomerExcludingAssessedTax','RevenueFromContractWithCustomerIncludingAssessedTax','SalesRevenueNet','Revenues'],
  profit:['NetIncomeLossAvailableToCommonStockholdersBasic','NetIncomeLoss'],
  cfo:['NetCashProvidedByUsedInOperatingActivities'],
  capex:['PaymentsToAcquirePropertyPlantAndEquipment'],
  eps:['EarningsPerShareDiluted'],
  dilutedShares:['WeightedAverageNumberOfDilutedSharesOutstanding']
};
const productiveAssets='PaymentsToAcquireProductiveAssets';

async function optionalJson(path) {
  try {return JSON.parse(gunzipSync(await readFile(path)).toString('utf8'));}
  catch(error) {if(error.code === 'ENOENT')return null;throw error;}
}
async function saveJson(path, value) {
  await writeFile(path+'.tmp', gzipSync(JSON.stringify(value)), {mode:0o600});
  await rename(path+'.tmp',path);
}
function htmlText(value) {
  return value.replace(/<[^>]*>/g,' ').replace(/&#0*38;|&amp;/g,'&').replace(/&nbsp;|&#160;/g,' ').replace(/\[\d+\]/g,'').replace(/\s+/g,' ').trim();
}

export function parseCikMap(html) {
  const table = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].map(match=>match[0]).find(value=>/\bCIK\b/.test(value));
  if(!table)throw Error('CIK标识表缺少CIK列');
  const records = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(match=>[...match[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(cell=>htmlText(cell[1])));
  const header=records.shift()||[], symbolAt=header.indexOf('Symbol'), cikAt=header.indexOf('CIK'), sectorAt=header.indexOf('GICS Sector'), nameAt=header.indexOf('Security');
  if(symbolAt<0||cikAt<0)throw Error('CIK标识表列发生变化');
  const result={};
  for(const row of records){const symbol=normalizeSymbol(row[symbolAt]),cik=row[cikAt];if(/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)&&/^\d{1,10}$/.test(cik||''))result[symbol]={symbol,cik:cik.padStart(10,'0'),name:row[nameAt]||symbol,industry:row[sectorAt]||null};}
  return result;
}
function csvRows(text) {
  const rows=[];let row=[],value='',quoted=false;
  for(let index=0;index<text.length;index++){
    const char=text[index];
    if(char==='"'){if(quoted&&text[index+1]==='"'){value+='"';index++;}else quoted=!quoted;}
    else if(char===','&&!quoted){row.push(value);value='';}
    else if((char==='\n'||char==='\r')&&!quoted){if(char==='\r'&&text[index+1]==='\n')index++;row.push(value);if(row.some(Boolean))rows.push(row);row=[];value='';}
    else value+=char;
  }
  if(value||row.length){row.push(value);rows.push(row);}if(quoted)throw Error('持仓CSV引号不完整');return rows;
}
export function parseReferenceUniverse(text) {
  const rows=csvRows(text),dateRow=rows.find(row=>row[0]?.includes('Fund Holdings as of')),asOf=sourceDay(dateRow?.[1]);
  const headerAt=rows.findIndex(row=>row[0]==='Ticker'&&row.includes('Asset Class'));
  if(!asOf||headerAt<0)throw Error('发行人持仓缺少日期或证券列');
  const headers=rows[headerAt],assetAt=headers.indexOf('Asset Class'),sectorAt=headers.indexOf('Sector'),nameAt=headers.indexOf('Name');
  const members=rows.slice(headerAt+1).filter(row=>row[assetAt]==='Equity').map(row=>({symbol:normalizeSymbol(row[0]),name:row[nameAt],industry:row[sectorAt]})).filter(row=>/^[A-Z][A-Z0-9.]{0,9}$/.test(row.symbol));
  if(members.length<80||members.length>120||new Set(members.map(row=>row.symbol)).size!==members.length)throw Error('发行人参考池数量异常，不发布不完整名册');
  return {asOf,members};
}

function observations(facts,tags,unit,cutoff,accession) {
  const values=[];
  for(const [priority,tag] of tags.entries())for(const item of facts?.facts?.['us-gaap']?.[tag]?.units?.[unit]||[]){
    if(accession&&item.accn!==accession||!Number.isFinite(item.val)||!validDay(item.end)||!validDay(item.filed)||item.filed>cutoff||item.end>cutoff||!/^10-[KQ](?:\/A)?$/.test(item.form||''))continue;
    const days=validDay(item.start)?Math.round((Date.parse(item.end)-Date.parse(item.start))/dayMs)+1:null;
    if(days!==null&&days<=0)continue;
    values.push({...item,tag,days,priority,fiscalYear:days>=330&&days<=380&&item.form.startsWith('10-K')});
  }
  const unique=new Map();
  for(const value of values){
    const key=(value.start||'')+'|'+value.end,prior=unique.get(key);
    const best=!prior||value.filed>prior.filed||(value.filed===prior.filed&&value.priority<prior.priority)?value:prior;
    unique.set(key,{...best,fiscalYear:value.fiscalYear||prior?.fiscalYear||false});
  }
  return [...unique.values()].sort((a,b)=>b.end.localeCompare(a.end)||b.filed.localeCompare(a.filed));
}
function annualValues(records) {
  const years=new Map();
  for(const item of records.filter(row=>row.fiscalYear))if(!years.has(item.end))years.set(item.end,item);
  return [...years.values()].sort((a,b)=>b.end.localeCompare(a.end));
}
function trailingValue(records,anchor,{allowQuarters=true}={}) {
  const annual=annualValues(records),lastYear=annual[0];
  const current=lastYear&&records.find(item=>item.end>lastYear.end&&(!anchor||item.end===anchor)&&item.days>=60&&item.days<=320&&Date.parse(item.start)>Date.parse(lastYear.end)&&Date.parse(item.start)-Date.parse(lastYear.end)<=15*dayMs);
  const latestEnd=anchor||records.find(item=>item.days>=60)?.end;
  const reported=records.find(item=>item.end===latestEnd&&item.days>=330&&item.days<=380);
  if(reported)return {value:reported.val,end:reported.end,parts:[reported]};
  if(current?.end===latestEnd){
    const previous=records.filter(item=>comparablePeriod(current,item)).sort((a,b)=>b.filed.localeCompare(a.filed))[0];
    if(previous)return {value:lastYear.val+current.val-previous.val,end:current.end,parts:[lastYear,current,previous]};
  }
  if(!allowQuarters)return null;
  const quarters=[];
  let end=latestEnd;
  while(quarters.length<4){
    const quarter=records.find(item=>item.end===end&&item.days>=75&&item.days<=105);
    if(!quarter)return null;
    quarters.push(quarter);
    end=new Date(Date.parse(quarter.start)-dayMs).toISOString().slice(0,10);
  }
  const days=quarters.reduce((sum,item)=>sum+item.days,0);
  return days>=330&&days<=380&&quarters.every(item=>item.tag===quarters[0].tag)?{value:quarters.reduce((sum,item)=>sum+item.val,0),end:latestEnd,parts:quarters}:null;
}
function comparablePeriod(current,prior){
  return current.tag===prior.tag&&prior.days>=60&&Math.abs(prior.days-current.days)<=10&&Math.abs((Date.parse(current.end)-Date.parse(prior.end))/dayMs-365)<=15&&Math.abs((Date.parse(current.start)-Date.parse(prior.start))/dayMs-365)<=15;
}
function companyProfit(facts,cutoff,accession){
  const reported=observations(facts,moneyTags.profit,'USD',cutoff,accession);
  const consolidated=observations(facts,['ProfitLoss'],'USD',cutoff,accession);
  const minority=observations(facts,['NetIncomeLossAttributableToNoncontrollingInterest'],'USD',cutoff,accession);
  const recovered=consolidated.flatMap(item=>{
    if(reported.some(value=>value.start===item.start&&value.end===item.end))return [];
    const portion=minority.find(value=>value.start===item.start&&value.end===item.end&&value.accn===item.accn);
    return portion?[{...item,val:item.val-portion.val,tag:'ProfitLoss less NetIncomeLossAttributableToNoncontrollingInterest'}]:[];
  });
  return [...reported,...recovered].sort((a,b)=>b.end.localeCompare(a.end)||b.days-a.days);
}
function instantaneous(facts,tags,unit,cutoff,end,accession) {
  const values=[];
  for(const [priority,tag] of tags.entries())for(const namespace of ['us-gaap','dei'])for(const value of facts?.facts?.[namespace]?.[tag]?.units?.[unit]||[]){
    if(accession&&value.accn!==accession||end&&value.end!==end||value.start||!Number.isFinite(value.val)||!validDay(value.end)||!validDay(value.filed)||value.filed>cutoff||value.end>cutoff||!/^10-[KQ](?:\/A)?$/.test(value.form||''))continue;
    values.push({...value,tag,priority});
  }
  return values.sort((a,b)=>b.end.localeCompare(a.end)||b.filed.localeCompare(a.filed)||a.priority-b.priority)[0]||null;
}
function matchedDebt(facts,cutoff,end,accession){
  const read=tags=>instantaneous(facts,tags,'USD',cutoff,end,accession);
  if(!end)return {cash:null,parts:[],missing:['cash','debt']};
  const cash=read(['CashAndCashEquivalentsAtCarryingValue']);
  const total=read(['DebtAndCapitalLeaseObligations','DebtLongtermAndShorttermCombinedAmount']);
  if(total?.val>=0)return {cash,parts:[total],missing:cash?.val>=0?[]:['cash']};
  const current=read(['DebtCurrent']);
  const maturities=read(['LongTermDebtCurrent','LongTermDebtAndFinanceLeaseObligationsCurrent','LongTermDebtAndCapitalLeaseObligationsCurrent']);
  const long=read(['LongTermDebtNoncurrent','LongTermDebtAndFinanceLeaseObligationsNoncurrent','LongTermDebtAndCapitalLeaseObligationsNoncurrent']);
  const longTotal=read(['LongTermDebt','LongTermDebtAndCapitalLeaseObligations']);
  const short=read(['ShortTermBorrowings']);
  let parts=[];
  if(current?.val>=0&&long?.val>=0)parts=[current,long];
  else if(short?.val>=0&&longTotal?.val>=0)parts=[short,longTotal];
  else if(short?.val>=0&&maturities?.val>=0&&long?.val>=0)parts=[short,maturities,long];
  const missing=[];
  if(!(cash?.val>=0))missing.push('cash');
  if(!parts.length){
    if(!(current?.val>=0)&&!(short?.val>=0))missing.push('short_term_debt');
    if(!(long?.val>=0)&&!(longTotal?.val>=0))missing.push('noncurrent_debt');
    if(!(current?.val>=0)&&!(longTotal?.val>=0)&&!(maturities?.val>=0))missing.push('current_debt_maturities');
    if(!missing.some(key=>key!=='cash'))missing.push('debt');
  }
  return {cash,parts,missing};
}
function operatingCycle(facts,filing,priceStamp,asOf){
  const accepted=Date.parse(filing?.accepted||'');
  if(!asOf||!Number.isFinite(priceStamp)||!Number.isFinite(accepted)||accepted>priceStamp||filing.reportDate&&filing.reportDate!==asOf)return null;
  const tags=key=>moneyTags[key].map(tag=>observations(facts,[tag],'USD',filing.filed,filing.accession));
  const annual=filing.form.startsWith('10-K');
  const revenue=tags('revenue').map(series=>{
    const current=series.filter(item=>item.end===asOf&&(annual?item.days>=330&&item.days<=380:item.days>=60&&item.days<=320)).sort((a,b)=>b.days-a.days)[0];
    const prior=current&&series.find(item=>comparablePeriod(current,item));
    return prior?.val>0?{current,prior}:null;
  }).find(Boolean);
  if(!revenue)return null;
  const profitSeries=companyProfit(facts,filing.filed,filing.accession);
  const currentProfit=profitSeries.find(item=>item.start===revenue.current.start&&item.end===revenue.current.end);
  const priorProfit=currentProfit&&profitSeries.find(item=>item.tag===currentProfit.tag&&item.start===revenue.prior.start&&item.end===revenue.prior.end);
  const profit=priorProfit?.val>0?{current:currentProfit,prior:priorProfit}:null;
  return {periodEnd:asOf,basis:annual?'fiscal_year':'fiscal_ytd',revenueGrowthPct:100*(revenue.current.val/revenue.prior.val-1),profitGrowthPct:profit?100*(profit.current.val/profit.prior.val-1):null,sourceTime:filing.accepted,revenueTag:revenue.current.tag,profitTag:profit?.current.tag??null};
}
function cashFlowBasis(facts,cutoff,anchor,cashflows){
  const alternatives=[...moneyTags.capex,productiveAssets].map(tag=>{
    const records=observations(facts,[tag],'USD',cutoff).filter(item=>item.val>=0);
    const annual=annualValues(records);
    const capex=anchor?trailingValue(records,anchor):null;
    const annualFcf=cashflows.flatMap(item=>{
      const costs=annual.find(value=>value.start===item.start&&value.end===item.end);
      return costs?[{...item,val:item.val-costs.val}]:[];
    });
    return {tag,capex,annualFcf};
  });
  return alternatives.find(item=>item.capex&&item.annualFcf.length>=3)||alternatives.find(item=>item.capex)||alternatives[0];
}
function consecutivePositive(rows) {
  let count=0,previous=null;
  for(const row of rows){
    const gap=previous?(Date.parse(previous)-Date.parse(row.end))/dayMs:null;
    if(row.val<=0||gap!==null&&(gap<330||gap>400))break;
    count++;previous=row.end;
  }
  return count;
}
function recentFilings(submissions) {
  const recent=submissions?.filings?.recent||{};
  return (recent.accessionNumber||[]).map((accession,index)=>({accession,form:recent.form?.[index],filed:recent.filingDate?.[index],accepted:recent.acceptanceDateTime?.[index],document:recent.primaryDocument?.[index],reportDate:recent.reportDate?.[index]})).filter(row=>/^10-[KQ](?:\/A)?$/.test(row.form||''));
}
function reportSource(cik,filing) {
  return filing?{name:'SEC '+filing.form,url:'https://www.sec.gov/Archives/edgar/data/'+Number(cik)+'/'+filing.accession.replaceAll('-','')+'/'+filing.document,asOf:filing.accepted||filing.filed}:null;
}
function containsFiling(facts,accession) {
  for(const namespace of Object.values(facts.facts||{}))for(const concept of Object.values(namespace))for(const records of Object.values(concept.units||{}))if(records.some(record=>record.accn===accession))return true;
  return false;
}

export function evaluateCompany({stock,facts,submissions,price,now=Date.now(),parameters,readAt}) {
  const cutoff=new Date(now).toISOString().slice(0,10),cik=String(stock.cik||'').padStart(10,'0');
  const filings=recentFilings(submissions).filter(row=>row.filed<=cutoff).sort((a,b)=>b.filed.localeCompare(a.filed)),latest=filings[0];
  const row={symbol:stock.symbol,name:submissions?.name||stock.name,kind:'stock',cik,industry:stock.industry||submissions?.sicDescription||null,status:'pending',financialPassed:false,valuationStatus:'pending',asOf:null,filedAt:latest?.filed||null,sourceTime:latest?.accepted||latest?.filed||null,sourceTimePrecision:latest?.accepted?'timestamp':'day',readAt,metrics:{},reasons:[],sources:[]};
  const source=reportSource(cik,latest);if(source)row.sources.push(source);
  row.sources.push({name:'SEC companyfacts',url:'https://data.sec.gov/api/xbrl/companyfacts/CIK'+cik+'.json',asOf:latest?.filed||null});
  if(String(facts?.cik).replace(/^0+/,'')!==String(Number(cik))||normalizeSymbol(stock.symbol)&&!(submissions?.tickers||[]).map(normalizeSymbol).includes(normalizeSymbol(stock.symbol))){row.reasons.push(issue('cik_symbol_mismatch','SEC公司标识与证券代码未核对通过'));return {fundamental:row,dca:{...row}};}
  row.sic=/^\d{3,4}$/.test(String(submissions.sic))?String(submissions.sic).padStart(4,'0'):null;
  row.sicDescription=typeof submissions.sicDescription==='string'?submissions.sicDescription:null;
  const series=Object.fromEntries(Object.entries(moneyTags).filter(([key])=>!['capex','profit'].includes(key)).map(([key,tags])=>[key,observations(facts,tags,key==='eps'?'USD/shares':key==='dilutedShares'?'shares':'USD',cutoff)]));
  series.profit=companyProfit(facts,cutoff);
  const reportDate=validDay(latest?.reportDate)?latest.reportDate:null;
  const revenue=trailingValue(series.revenue,reportDate),anchor=reportDate||revenue?.end;
  const profit=trailingValue(series.profit,anchor),cfo=trailingValue(series.cfo,anchor),eps=trailingValue(series.eps,anchor,{allowQuarters:false});
  const revenues=annualValues(series.revenue),profits=annualValues(series.profit),cashflows=annualValues(series.cfo),diluted=annualValues(series.dilutedShares);
  const {tag:capexTag,capex,annualFcf}=cashFlowBasis(facts,cutoff,anchor,cashflows);
  const {cash,parts:debtParts,missing:debtMissing}=matchedDebt(facts,cutoff,anchor,reportDate?latest.accession:null);
  const coverShares=instantaneous(facts,['EntityCommonStockSharesOutstanding'],'shares',cutoff);
  const balanceShares=anchor?instantaneous(facts,['CommonStockSharesOutstanding'],'shares',cutoff,anchor):null;
  const shares=coverShares?.val>0&&ageDays(coverShares.end,now)<=parameters.maxShareAgeDays?coverShares:balanceShares;
  const fcf=cfo&&capex&&capex.value>=0?cfo.value-capex.value:null;
  const netDebt=debtMissing.length?null:debtParts.reduce((total,item)=>total+item.val,0)-cash.val;
  const profitYears=consecutivePositive(profits),fcfYears=consecutivePositive(annualFcf),dilution=diluted.length>=2&&diluted[1].val>0?(diluted[0].val/diluted[1].val-1)*100:null;
  const priorRevenue=revenues[1],annualGrowth=revenues[0]&&priorRevenue&&priorRevenue.val>0?(revenues[0].val/priorRevenue.val-1)*100:null;
  const priceStamp=Date.parse(price?.asOf||'');
  const priceAllowed=price?.permissionsVerified===true&&price?.derivedPublic===true&&Number.isFinite(price.close)&&price.close>0&&Number.isFinite(priceStamp)&&priceStamp<=now&&now-priceStamp<=parameters.maxPriceAgeDays*dayMs;
  row.operatingCycle=priceAllowed?operatingCycle(facts,latest,priceStamp,anchor):null;
  const ytdGrowth=revenue?.parts.length===3&&revenue.parts[2].val>0?(revenue.parts[1].val/revenue.parts[2].val-1)*100:null;
  const growth=row.operatingCycle?.revenueGrowthPct??ytdGrowth??annualGrowth;
  const normalizedProfit=profit&&profits.length>=3?Math.min(profit.value,median(profits.slice(0,3).map(item=>item.val))):null;
  const normalizedFcf=fcf!==null&&annualFcf.length>=3?Math.min(fcf,median(annualFcf.slice(0,3).map(item=>item.val))):null;
  row.asOf=anchor||null;row.metrics={currency:'USD',revenueTtm:revenue?.value??null,netIncomeTtm:profit?.value??null,operatingCashFlowTtm:cfo?.value??null,capexTtm:capex?.value??null,fcfTtm:fcf,reportedDilutedEpsTtmApprox:eps?.value??null,normalizedNetIncome:normalizedProfit,annualProfitYears:profitYears,annualFcfYears:fcfYears,revenueGrowthPct:growth,revenueGrowthBasis:row.operatingCycle?.basis==='fiscal_ytd'||ytdGrowth!==null?'latest_reported_ytd':'latest_full_fiscal_year',annualRevenueGrowthPct:annualGrowth,netDebtToFcf:netDebt!==null&&fcf>0?netDebt/fcf:null,dilutionPct:dilution,pe:null,normalizedPe:null,fcfYield:null,normalizedFcfYield:null};
  const fieldLabels={revenue_ttm:'近12个月营收',profit_ttm:'近12个月净利',cash_flow_ttm:'近12个月经营现金流',capex_ttm:'近12个月资本支出',profit_history:'3年完整年度净利',fcf_history:'3年完整年度自由现金流',cash:'同期间现金及现金等价物',debt:'同期间完整债务',short_term_debt:'同期间短期借款',noncurrent_debt:'同期间长期债务',current_debt_maturities:'同期间一年内到期长债',dilution:'同口径年度摊薄股数',revenue_growth:'可比期间营收同比'};
  const missingFields=[
    ...[[revenue?.value,'revenue_ttm'],[profit?.value,'profit_ttm'],[cfo?.value,'cash_flow_ttm'],[capex?.value,'capex_ttm'],[normalizedProfit,'profit_history'],[normalizedFcf,'fcf_history'],[dilution,'dilution'],[growth,'revenue_growth']].filter(([value])=>!Number.isFinite(value)).map(([,key])=>key),
    ...debtMissing
  ];
  const sourcePart=item=>({tag:item.tag,periodStart:item.start||null,periodEnd:item.end,filedAt:item.filed,accession:item.accn||null});
  row.financialEvidence={periodEnd:row.asOf,capexTag:capex?capexTag:null,capexSource:capex?.parts.map(sourcePart)||[],debtTags:debtParts.map(item=>item.tag),cashTag:cash?.tag??null,debtSource:[...(cash?[cash]:[]),...debtParts].map(sourcePart),missingFields:missingFields.map(code=>({code,label:fieldLabels[code]}))};
  row.normalization={method:'min(TTM, median of latest 3 full fiscal years); earnings use net income, not sums of weighted EPS',years:profits.slice(0,3).map(item=>item.end),historicalPointInTimeBacktest:false};
  const specialized=Number(submissions?.sic)>=6000&&Number(submissions?.sic)<6800||/Banks|Insurance|Capital Markets|Real Estate|REIT|Consumer Finance/i.test(stock.industry||'');
  if(specialized)row.reasons.push(issue('sector_method_pending','金融、保险或地产口径需独立核验，不套用工业企业自由现金流估值'));
  if(stock.listingVerified===false)row.reasons.push(issue('listing_pending','当前行情名册未核验到该证券代码'));
  if(!anchor||ageDays(anchor,now)>parameters.maxReportAgeDays)row.reasons.push(issue('financial_period_stale','最新财报期间不足或过旧'));
  if(missingFields.length)row.reasons.push(issue('financial_fields_missing','待补：'+row.financialEvidence.missingFields.map(field=>field.label).join('、')));
  if(profits[0]?.end!==revenues[0]?.end||annualFcf[0]?.end!==revenues[0]?.end)row.reasons.push(issue('annual_period_missing','多年盈利和现金流没有覆盖同一最新完整年度'));
  const enough=profitYears>=parameters.minimumProfitYears&&fcfYears>=parameters.minimumFcfYears;
  if(!enough)row.reasons.push(issue('profit_fcf_history_short','连续盈利或自由现金流年数未达门槛'));
  if(profit?.value<=0||fcf!==null&&fcf<=0||normalizedProfit!==null&&normalizedProfit<=0||normalizedFcf!==null&&normalizedFcf<=0)row.reasons.push(issue('profit_or_fcf_nonpositive','当前或中周期盈利、自由现金流非正'));
  if(growth!==null&&growth<0)row.reasons.push(issue('revenue_declining','最近已披露同期间收入同比下降'));
  if(row.metrics.netDebtToFcf!==null&&row.metrics.netDebtToFcf>parameters.maxNetDebtToFcf)row.reasons.push(issue('debt_above_limit','净债务相对自由现金流超过门槛'));
  if(dilution!==null&&dilution>parameters.maxDilutionPct)row.reasons.push(issue('dilution_above_limit','年度摊薄股数增幅超过门槛'));
  row.financialPassed=row.reasons.length===0;
  const multipleClasses=(submissions?.tickers||[]).filter(ticker=>!ticker.includes('/')).length>1;
  if(!priceAllowed)row.reasons.push(issue('price_permission_or_freshness_pending','价格缺失、过期或公开派生许可待核；财报结果仍保留'));
  else if(multipleClasses)row.reasons.push(issue('share_class_pending','多股权类别的每股盈利和总股数换算待核'));
  else if(!shares||shares.val<=0||ageDays(shares.end,now)>parameters.maxShareAgeDays)row.reasons.push(issue('share_count_pending','可核验期末普通股数不足或过期'));
  else if(latest?.accepted&&Date.parse(latest.accepted)>priceStamp)row.reasons.push(issue('price_before_latest_filing','价格早于最新财报公开时点，估值待新报价核验'));
  else if(profit?.value>0&&fcf>0){
    const cap=price.close*shares.val;row.metrics.pe=cap/profit.value;row.metrics.fcfYield=100*fcf/cap;row.metrics.normalizedPe=normalizedProfit>0?cap/normalizedProfit:null;row.metrics.normalizedFcfYield=normalizedFcf>0?100*normalizedFcf/cap:null;
    row.valuationBasis={priceAsOf:price.asOf,priceSource:price.sourceId,shareCountAsOf:shares.end,shareCountTag:shares.tag,financialPeriod:anchor,marketCapIsEstimate:true};
    if(Number.isFinite(row.metrics.normalizedPe)&&Number.isFinite(row.metrics.normalizedFcfYield))row.valuationStatus=row.metrics.normalizedPe<=parameters.maxNormalizedPe&&row.metrics.normalizedFcfYield>=parameters.minNormalizedFcfYield?'low_multiple':'not_low';
  }
  const unknown=row.reasons.some(item=>/pending|missing|stale|short/.test(item.code));
  row.status=row.financialPassed&&row.valuationStatus==='low_multiple'?'candidate':unknown||row.valuationStatus==='pending'?'pending':'excluded';
  if(row.valuationStatus==='not_low')row.reasons.push(issue('valuation_above_limit','中周期市盈率或自由现金流收益率未达低倍数门槛'));
  row.severelyUndervalued=false;
  row.valuationConclusion=row.status==='candidate'?'质量与低倍数研究候选，未建立公允价值区间':'未确认严重低估';
  const dca=structuredClone(row);dca.strategy='long_term_stock';
  if(profitYears<parameters.dcaMinimumProfitYears||fcfYears<parameters.dcaMinimumFcfYears)dca.reasons.push(issue('dca_history_short','长期个股需更长的连续盈利和自由现金流记录'));
  const dcaValue=row.metrics.normalizedPe!==null&&row.metrics.normalizedFcfYield!==null&&row.metrics.normalizedPe<=parameters.dcaMaxNormalizedPe&&row.metrics.normalizedFcfYield>=parameters.dcaMinNormalizedFcfYield;
  dca.status=row.financialPassed&&profitYears>=parameters.dcaMinimumProfitYears&&fcfYears>=parameters.dcaMinimumFcfYears&&dcaValue?'candidate':unknown||row.valuationStatus==='pending'?'pending':'excluded';
  dca.reasons=dca.reasons.filter(item=>item.code!=='valuation_above_limit');
  if(!dcaValue&&row.valuationStatus!=='pending')dca.reasons.push(issue('dca_valuation_above_limit','长期个股估值仍未达到预设门槛'));
  return {fundamental:row,dca};
}

export function evaluateEtf(metadata,{now,readAt,parameters,sourceCheck}) {
  const stale=ageDays(metadata.holdingsAsOf,now)>parameters.etfMaxMetadataAgeDays||metadata.holdingsAsOf>new Date(now).toISOString().slice(0,10),changed=sourceCheck?.changed===true;
  const eligible=metadata.assetClass==='equity'&&metadata.leveraged===false&&metadata.inverse===false&&metadata.indexTracking===true&&metadata.expenseRatio<=parameters.etfMaxExpenseRatio&&metadata.holdingsCount>=parameters.etfMinHoldings;
  const reasons=[issue('strategy_definition',metadata.reason),issue('risk',metadata.risk)];
  if(stale)reasons.push(issue('metadata_stale','持仓资料已过期，等待发行人新资料核验'));
  if(changed)reasons.push(issue('issuer_document_changed','发行人文档发生变化，保留上次核验值并等待字段复核'));
  if(sourceCheck?.error)reasons.push(issue('issuer_check_failed','发行人本轮读取失败，保留带原日期的核验资料'));
  return {symbol:metadata.symbol,name:metadata.name,kind:'etf',style:metadata.style,status:eligible&&!stale&&!changed&&!sourceCheck?.error?'candidate':'pending',asOf:metadata.holdingsAsOf,sourceTime:metadata.holdingsAsOf,sourceTimePrecision:'day',readAt,metadataVerifiedAt:metadata.metadataVerifiedAt,sourceCheckedAt:sourceCheck?.checkedAt||null,stale:stale||changed||Boolean(sourceCheck?.error),metrics:{expenseRatio:metadata.expenseRatio,holdingsCount:metadata.holdingsCount,top10Weight:metadata.top10Weight,top10AsOf:metadata.top10AsOf||metadata.holdingsAsOf,portfolioPe:metadata.portfolioPe,portfolioPeAsOf:metadata.portfolioPeAsOf},benchmark:metadata.benchmark,reasons,sources:[{name:'发行人资料',url:metadata.sourceUrl,asOf:metadata.holdingsAsOf}],valuationConclusion:'长期分批投入研究候选；不表示目前低估或保证盈利'};
}

export function parseEtfDocument(text,metadata) {
  const plain=htmlText(text),vanguard=metadata.sourceUrl.endsWith('.pdf');
  if(!new RegExp('\\b'+metadata.symbol+'\\b').test(plain))throw Error('发行人基金代码未核验通过');
  const fee=plain.match(vanguard?/Expense\s+ratio(?:\s*\d+)?\s+(\d+(?:\.\d+)?)\s*%/i:/Total\s+Expense\s+Ratio\s*:?\s*(\d+(?:\.\d+)?)\s*%/i);
  const holdings=plain.match(vanguard?/Number of stocks\s+([\d,]+)/i:/Total Holdings\s+As of\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+([\d,]+)/i);
  const date=plain.match(vanguard?/As of\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/:/Total Holdings\s+As of\s+(\d{1,2}\/\d{1,2}\/\d{4})/i),holdingsAsOf=sourceDay(date?.[1]);
  if(!fee||!holdings||!holdingsAsOf)throw Error('发行人基金费率、持仓数或日期字段未核验，保留旧数据');
  const expenseRatio=Number(fee[1]),holdingsCount=Number((vanguard?holdings[1]:holdings[2]).replaceAll(',',''));
  if(expenseRatio<0||expenseRatio>5||holdingsCount<1||holdingsCount>100000)throw Error('发行人基金字段超出有效范围');
  const pe=plain.match(vanguard?/Price\/earnings ratio\s+(\d+(?:\.\d+)?)\s*x/i:/Price to Earnings Ratio\s+As of\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d+(?:\.\d+)?)/i);
  const top=plain.match(/Top ten as\s*%\s*of total net assets\s+(\d+(?:\.\d+)?)\s*%/i);
  const section=!vanguard?plain.split('Top Holdings')[1]?.split('Sectors')[0]||'':'',weights=[...section.matchAll(/Percent of Assets\s*\(%\)\s*(\d+(?:\.\d+)?)\s*%/gi)].slice(0,10).map(match=>Number(match[1]));
  const topWeight=top?Number(top[1]):weights.length===10?weights.reduce((sum,value)=>sum+value,0):null;
  const topDate=sourceDay(section.match(/As of\s+(\d{1,2}\/\d{1,2}\/\d{4})/i)?.[1]);
  return {...metadata,expenseRatio,holdingsCount,holdingsAsOf,top10Weight:topWeight,top10AsOf:topWeight!==null?(vanguard?holdingsAsOf:topDate):null,portfolioPe:pe?Number(vanguard?pe[1]:pe[2]):null,portfolioPeAsOf:pe?(vanguard?holdingsAsOf:sourceDay(pe[1])):null};
}

export async function collectFundamentals({directory,universe=[],prices={},now=Date.now,onProgress=()=>{},fetch:request=globalThis.fetch,config,wait=sleep}={}) {
  const timestamp=typeof now==='function'?now():now,readAt=new Date(timestamp).toISOString(),settings=config||JSON.parse(await readFile(process.env.BOOKS_SITE_DIR?join(process.env.BOOKS_SITE_DIR,'research-data/us-fundamental-universe.json'):configUrl,'utf8')),parameters=settings.parameters;
  const base=join(directory,'fundamentals'),privateDir=join(base,'private'),archive=join(privateDir,'archives');await mkdir(archive,{recursive:true});
  const holdsPath=join(privateDir,'source-holds.json.gz'),holds=await optionalJson(holdsPath)||{},failures=[];let previousRequest=0;
  async function get(url) {
    const host=new URL(url).hostname;if(holds[host])throw Error(host+' 来源已停止：'+holds[host].reason);
    const elapsed=Date.now()-previousRequest;if(elapsed<550)await wait(550-elapsed);previousRequest=Date.now();
    const response=await request(url,{headers:{'User-Agent':process.env.BOOKS_SEC_USER_AGENT||'BooksResearch/1.0 contact=https://45-77-39-98.sslip.io','Accept':'application/json,text/csv,text/html,application/pdf'},signal:AbortSignal.timeout(25000),redirect:'error'});
    if([401,403,418,429,451].includes(response.status)){holds[host]={reason:'HTTP '+response.status,stoppedAt:readAt};await saveJson(holdsPath,holds);throw Error(host+' HTTP '+response.status+'，已停止该来源，不更换入口');}
    if(!response.ok)throw Error(host+' HTTP '+response.status);
    return Buffer.from(await response.arrayBuffer());
  }
  async function textCache(key,url,maxAgeDays) {
    const path=join(privateDir,key+'.json.gz'),prior=await optionalJson(path);
    if(prior&&timestamp-Date.parse(prior.readAt)<maxAgeDays*dayMs)return prior;
    try {const body=(await get(url)).toString('utf8'),next={body,readAt,url};await saveJson(path,next);return next;}
    catch(error){failures.push({source:url,reason:error.message});if(prior)return {...prior,stale:true,error:error.message};throw error;}
  }
  await onProgress({phase:'fundamentals_universe',processed:0,total:0});
  const prior=await optionalJson(join(privateDir,'last-success.json.gz'));
  const previousAttempt=await optionalJson(join(privateDir,'last-attempt.json.gz'));
  let members=[],scope,identifiers={};
  try {
    const [holdings,lookup]=await Promise.all([textCache('oef-holdings',settings.universeSource,1),textCache('cik-map',settings.cikMapSource,7)]);
    const parsed=parseReferenceUniverse(holdings.body);identifiers=parseCikMap(lookup.body);
    const bySymbol=new Map(parsed.members.map(row=>[row.symbol,{...identifiers[row.symbol],...row}]));
    for(const symbol of settings.referenceSymbols||[])if(!bySymbol.has(symbol))bySymbol.set(symbol,{symbol,name:identifiers[symbol]?.name||symbol,industry:identifiers[symbol]?.industry||null,...identifiers[symbol]});
    const listings=new Map(universe.map(row=>[normalizeSymbol(row.symbol),row]));
    members=[...bySymbol.values()].map(stock=>({...stock,...(listings.get(stock.symbol)?.cik?{cik:listings.get(stock.symbol).cik}:{}),listingVerified:listings.size?listings.has(stock.symbol):null}));
    scope={name:'S&P100代理持仓及行业参考池',basis:'issuer_oef_equity_holdings_plus_explicit_industry_references',fullMarket:false,asOf:parsed.asOf,source:settings.universeSource,identifierSource:settings.cikMapSource,total:members.length,listingCount:universe.length,stale:holdings.stale||lookup.stale||parsed.asOf>readAt.slice(0,10)||ageDays(parsed.asOf,timestamp)>parameters.maxUniverseAgeDays};
  } catch(error) {failures.push({source:'fundamentals_universe',reason:error.message});scope={name:'基本面参考池',fullMarket:false,total:0,stale:true};}
  const rows=[],dcaStocks=[];
  for(const [index,stock] of members.entries()){
    await onProgress({phase:'fundamentals',processed:index,total:members.length,symbol:stock.symbol});
    const previousAttemptRow=previousAttempt?.fundamentals?.rows?.find(row=>row.symbol===stock.symbol&&row.asOf);
    const previousAttemptDca=previousAttempt?.dca?.rows?.find(row=>row.symbol===stock.symbol&&row.kind==='stock'&&row.asOf);
    const priorRow=prior?.fundamentals?.rows?.find(row=>row.symbol===stock.symbol)||previousAttemptRow;
    const priorDca=prior?.dca?.rows?.find(row=>row.symbol===stock.symbol&&row.kind==='stock')||previousAttemptDca;
    let storedFacts;
    try {
      if(!stock.cik)throw Error('CIK标识映射不足，不猜测公司标识');
      const cik=String(stock.cik).padStart(10,'0'),subUrl='https://data.sec.gov/submissions/CIK'+cik+'.json',factsUrl='https://data.sec.gov/api/xbrl/companyfacts/CIK'+cik+'.json';
      const path=join(privateDir,'facts-'+cik+'.json.gz');
      storedFacts=await optionalJson(path);
      const sub=await textCache('submissions-'+cik,subUrl,.25),submissions=JSON.parse(sub.body);
      if(!(submissions.tickers||[]).map(normalizeSymbol).includes(stock.symbol))throw Error('CIK与SEC ticker未核验通过');
      const latest=recentFilings(submissions).filter(row=>row.filed<=readAt.slice(0,10)).sort((a,b)=>b.filed.localeCompare(a.filed))[0];
      let factsRecord=storedFacts;
      if(!factsRecord||factsRecord.accession!==latest?.accession){
        const body=(await get(factsUrl)).toString('utf8'),facts=JSON.parse(body);
        if(String(facts.cik).replace(/^0+/,'')!==String(Number(cik)))throw Error('SEC facts公司标识异常');
        if(!latest||!containsFiling(facts,latest.accession))throw Error('SEC companyfacts尚未包含最新申报；保留旧数据日期，等待后续任务更新');
        factsRecord={body,readAt,url:factsUrl,accession:latest?.accession||null};await saveJson(path,factsRecord);
        await saveJson(join(archive,cik+'-'+(latest?.accession||readAt.slice(0,10))+'.json.gz'),{submissions,facts,readAt});
      }
      const evaluated=evaluateCompany({stock,facts:JSON.parse(factsRecord.body),submissions,price:prices[stock.symbol]||prices[stock.symbol+'.US'],now:timestamp,parameters,readAt:factsRecord.readAt});
      if(scope.stale||sub.stale){for(const row of [evaluated.fundamental,evaluated.dca]){row.stale=true;row.status='pending';row.operatingCycle=null;row.reasons.push(issue('universe_or_source_stale','参考池或财报来源本轮未核验更新，保留已有数据'));}}
      rows.push(evaluated.fundamental);dcaStocks.push(evaluated.dca);
    }catch(error){
      if(!/CIK标识映射不足|CIK与SEC ticker未核验通过/.test(error.message))failures.push({symbol:stock.symbol,source:'SEC',reason:error.message});
      const missing={symbol:stock.symbol,name:stock.name,kind:'stock',cik:stock.cik||null,industry:stock.industry||null,status:'pending',financialPassed:false,valuationStatus:'pending',asOf:null,sourceTime:null,readAt:null,metrics:{},sources:[],reasons:[]};
      const safeAccession=/^\d{10}-\d{2}-\d{6}$/.test(storedFacts?.accession||'');
      const oldArchive=(!priorRow||!priorDca)&&safeAccession?await optionalJson(join(archive,String(stock.cik).padStart(10,'0')+'-'+storedFacts.accession+'.json.gz')).catch(()=>null):null;
      const lastArchivedFiling=recentFilings(oldArchive?.submissions).filter(row=>row.filed<=readAt.slice(0,10)).sort((a,b)=>b.filed.localeCompare(a.filed))[0];
      const archived=lastArchivedFiling?.accession===storedFacts?.accession&&oldArchive?.facts?evaluateCompany({stock,facts:oldArchive.facts,submissions:oldArchive.submissions,now:timestamp,parameters,readAt:oldArchive.readAt}):null;
      for(const [target,old] of [[rows,priorRow||archived?.fundamental],[dcaStocks,priorDca||archived?.dca]]){
        const reasons=(old?.reasons||[]).filter(reason=>reason.code!=='collection_failed_retained');
        target.push({...structuredClone(old||missing),status:'pending',financialPassed:false,valuationStatus:'pending',lastSuccessfulStatus:old?.lastSuccessfulStatus||old?.status||null,stale:true,operatingCycle:null,lastAttemptAt:readAt,reasons:[...reasons,issue('collection_failed_retained',error.message)]});
      }
    }
  }
  const previous=prior||previousAttempt;
  if(!members.length&&previous){
    const reason=[...new Set(failures.map(failure=>failure.reason))].join('；');
    for(const [target,olderRows] of [[rows,previous.fundamentals.rows||[]],[dcaStocks,(previous.dca.rows||[]).filter(row=>row.kind==='stock')]])for(const row of olderRows){
      const reasons=(row.reasons||[]).filter(item=>item.code!=='universe_failed_retained');
      target.push({...row,status:'pending',financialPassed:false,valuationStatus:'pending',lastSuccessfulStatus:row.lastSuccessfulStatus||row.status,stale:true,operatingCycle:null,lastAttemptAt:readAt,reasons:[...reasons,issue('universe_failed_retained',reason)]});
    }
  }
  const etfs=[];
  for(const metadata of settings.etfs||[]){
    const path=join(privateDir,'etf-'+metadata.symbol+'.json.gz'),cached=await optionalJson(path);let sourceCheck=cached?.sourceCheck,verifiedMetadata=cached?.metadata||metadata;
    if(!cached||timestamp-Date.parse(cached.readAt)>7*dayMs){
      try {
        const bytes=await get(metadata.sourceUrl);let text=bytes.toString('utf8');
        if(metadata.sourceUrl.endsWith('.pdf')){
          if(!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))throw Error('发行人返回的内容不是PDF');
          const parsed=spawnSync('pdftotext',['-layout','-','-'],{input:bytes,encoding:'utf8',timeout:15000,maxBuffer:4*1024*1024});
          if(parsed.error||parsed.status!==0)throw Error('PDF字段解析器不可用，保留原日期资料并停用自动候选');
          text=parsed.stdout;
        }
        verifiedMetadata={...parseEtfDocument(text,metadata),metadataVerifiedAt:readAt};sourceCheck={checkedAt:readAt,changed:false,fieldsParsed:true};await saveJson(path,{body:bytes.toString('base64'),readAt,metadata:verifiedMetadata,sourceCheck});
      }
      catch(error){sourceCheck={checkedAt:readAt,error:error.message};failures.push({symbol:metadata.symbol,source:metadata.sourceUrl,reason:error.message});}
    }
    etfs.push(evaluateEtf(verifiedMetadata,{now:timestamp,readAt,parameters,sourceCheck}));
  }
  const counts={total:rows.length,financialPassed:rows.filter(row=>row.financialPassed).length,lowMultiple:rows.filter(row=>row.status==='candidate').length,pending:rows.filter(row=>row.status==='pending').length,excluded:rows.filter(row=>row.status==='excluded').length,severelyUndervalued:0};
  const status=failures.length||scope.stale?'partial':rows.length?'ready':'unavailable';
  const result={fundamentals:{schema,status,scope,asOf:rows.map(row=>row.asOf).filter(Boolean).sort().at(-1)||null,computedAt:readAt,lastAttemptAt:readAt,counts,parameters,percentageUnit:'percent',rows,failures,reason:'代码逐只核验财报、3年中周期盈利与现金流、估值；低倍数不等于严重低估'},dca:{schema:'books.us.dca.v1',status,asOf:readAt.slice(0,10),computedAt:readAt,parameters:{minimumProfitYears:parameters.dcaMinimumProfitYears,minimumFcfYears:parameters.dcaMinimumFcfYears,maxExpenseRatio:parameters.etfMaxExpenseRatio,minHoldings:parameters.etfMinHoldings},percentageUnit:'percent',rows:[...etfs,...dcaStocks],failures,reason:'发行人基金资料按固定透明规则核验，个股按多年盈利、现金流、负债、稀释和估值核验'}};
  if(!failures.length&&rows.length)await saveJson(join(privateDir,'last-success.json.gz'),result);
  await saveJson(join(privateDir,'last-attempt.json.gz'),result);
  await onProgress({phase:'fundamentals_complete',processed:members.length,total:members.length,counts,failures:failures.length});
  return result;
}
