/* This Source Code Form is subject to the Mozilla Public License, v. 2.0.
 * https://mozilla.org/MPL/2.0/ — © Viprasol; native closed-bar port for Books.
 * Pine sources pinned at a16096c; formulas and original conditional ordering retained.
 * Naive Bayes Order Flow also credits PMT's Institutional Order Flow Signals.
 */
import {field,validateBars,parameters,sma,ema,rma,wma,sum,highest,lowest,stdev,atr,adx,pivots,linreg,supertrend,crossOver,crossUnder,rising,falling,rolling} from './viprasol-math.mjs';
const finite=Number.isFinite;
const shift=(a,n=1)=>a.map((_,i)=>i>=n?a[i-n]:null);
const map=(a,fn)=>a.map((v,i)=>finite(v)?fn(v,i):null);
const binary=(a,b,fn)=>a.map((v,i)=>finite(v)&&finite(b[i])?fn(v,b[i],i):null);
const bool=(key,label)=>({key,label,type:'boolean'});
const num=(key,label,min,max,integer=false)=>({key,label,type:'number',min,max,integer});
const select=(key,label,options)=>({key,label,type:'select',options});
const MA_TYPES=['SMA','EMA','WMA','RMA','VWMA','DEMA','TEMA','HMA','ALMA','T3','McGinley','ZLEMA','KAMA','FRAMA','VIDYA','SuperSmoother','Gaussian','Laguerre','Kalman','LSMA','Median'];
const sourceOptions=['close','open','high','low','hl2','hlc3','ohlc4'];
function source(b,p='close'){return b.map(x=>p==='hl2'?(x.high+x.low)/2:p==='hlc3'?(x.high+x.low+x.close)/3:p==='ohlc4'?(x.open+x.high+x.low+x.close)/4:x[p]);}
function definition(id,title,defaults,defs,dependencies=['ohlcv','mintick']){return {id,title,defaults,parameters:defs,sourceFile:'indicators/'+id+'.pine',dependencies};}
const maDefaults={almaOffset:.85,almaSigma:6,t3Factor:.7,mcgK:.6,kamaFast:2,kamaSlow:30,vidyaCmo:9,gaussPoles:2,lagGamma:.7,kalQ:.05,kalR:.01};
const maParams=[num('almaOffset','ALMA Offset',0,1),num('almaSigma','ALMA Sigma',.1),num('t3Factor','T3 Factor',0,1),num('mcgK','McGinley K',.1),num('kamaFast','KAMA Fast',1,undefined,true),num('kamaSlow','KAMA Slow',1,undefined,true),num('vidyaCmo','VIDYA CMO',1,undefined,true),num('gaussPoles','Gaussian Poles',1,4,true),num('lagGamma','Laguerre Gamma',.1,.99),num('kalQ','Kalman Q',.0001),num('kalR','Kalman R',.0001)];
export const catalog=[
 definition('absorption-radar-pro','Viprasol Absorption Radar Pro for Smart Money',{volLength:20,volMultiplier:1.5,wickRatio:.4,rangeLength:20,useTrendFilter:false,emaLength:200,useSweepFilter:false,cooldown:10,minGrade:'allGrades',showZones:true,zoneMode:'track',zoneExtension:20,showEMA:false,targetATR:1.5,targetRR1:1,targetRR2:2,targetRR3:3,stopAtHit:true},[num('volLength','Volume Average Length',5,undefined,true),num('volMultiplier','Volume Spike',1),num('wickRatio','Rejection Wick',.1,.9),num('rangeLength','Liquidity Lookback',5,undefined,true),bool('useTrendFilter','EMA Filter'),num('emaLength','EMA Length',20,undefined,true),bool('useSweepFilter','Require Sweep'),num('cooldown','Cooldown',0,undefined,true),select('minGrade','Minimum Grade',['allGrades','abOnly','aOnly']),bool('showZones','Absorption Zones'),select('zoneMode','Zone Mode',['track','fixed']),num('zoneExtension','Zone Extension',1,200,true),bool('showEMA','Show EMA'),num('targetATR','Stop ATR',.2),num('targetRR1','TP1 R',.5),num('targetRR2','TP2 R',1),num('targetRR3','TP3 R',1.5),bool('stopAtHit','End at Stop/Target')]),
 definition('apex-trend-signal-engine','APEX Trend & Signal Engine',{mode:'Auto (regime-aware)',maType:'HMA',trendLen:40,fastLen:20,srcIn:'close',adxThr:23,almaOff:.85,almaSig:6,t3Fac:.7,kamaF:2,kamaS:30,useLoc:true,rangeLen:50,showCloud:false,showMid:true,showZone:true,showExt:false,stFactor:3,stAtr:10,extLen:20,cloudType:'Donchian',sigGap:10,tpMult:2,slMult:2},[select('mode','Mode',['Auto (regime-aware)','Trend-Following','Mean-Reversion']),select('maType','Baseline MA',['SMA','EMA','WMA','RMA','HMA','ALMA','T3','KAMA']),num('trendLen','Trend Length',2,undefined,true),num('fastLen','Fast Length',2,undefined,true),select('srcIn','Source',sourceOptions),num('adxThr','ADX Threshold',5,50),num('almaOff','ALMA Offset'),num('almaSig','ALMA Sigma',.01),num('t3Fac','T3 Factor'),num('kamaF','KAMA Fast',1,undefined,true),num('kamaS','KAMA Slow',1,undefined,true),bool('useLoc','Location Filter'),num('rangeLen','Range',5,undefined,true),bool('showCloud','Cloud Filter'),bool('showMid','Midline'),bool('showZone','Adaptive Zone'),bool('showExt','Extreme Zones'),num('stFactor','Supertrend Factor',.5),num('stAtr','Supertrend ATR',1,undefined,true),num('extLen','Extreme Length',5,undefined,true),select('cloudType','Cloud',['Donchian','EMA','HMA']),num('sigGap','Signal Gap',0,500,true),num('tpMult','TP ATR',.5),num('slMult','SL ATR',.5)]),
 definition('edge-liquidity-engine','EDGE Liquidity Engine',{winInput:120,smoothInput:5,signedInput:false,regimeLenInput:250,hiPctInput:80,loPctInput:20,unitInput:'Basis Points',showRawInput:false},[num('winInput','Window',30,500,true),num('smoothInput','EMA Smoothing',1,50,true),bool('signedInput','Signed Estimate'),num('regimeLenInput','Regime Lookback',50,1000,true),num('hiPctInput','High Cost Percentile',55,99,true),num('loPctInput','Low Cost Percentile',1,45,true),select('unitInput','Unit',['Basis Points','Percent']),bool('showRawInput','Raw Estimate')],['ohlcv']),
 definition('elite-flow-pro','Viprasol Elite Flow Pro',{trend_type:'Adaptive',trend_sensitivity:21,cloud_multiplier:2,detect_zones:true,zone_strength:12,show_rejections:true,auto_extend:true,use_volume:true,volume_threshold:1.2,signal_mode:'Conservative',use_confirmation:true,show_cloud:true},[select('trend_type','Trend Type',['Fast','Adaptive','Smooth']),num('trend_sensitivity','Sensitivity',10,100,true),num('cloud_multiplier','Cloud Width',1,4),bool('detect_zones','Detect Zones'),num('zone_strength','Pivot Width',5,30,true),bool('show_rejections','Zone Rejections'),bool('auto_extend','Extend Zones'),bool('use_volume','Volume Filter'),num('volume_threshold','Volume Threshold',1),select('signal_mode','Mode',['Aggressive','Balanced','Conservative']),bool('use_confirmation','Confirmation'),bool('show_cloud','Show Cloud')],['ohlcv']),
 definition('equilibrium-confluence-engine','Equilibrium Confluence Engine',{emaFastInput:9,emaSlowInput:15,useTrendInput:true,swingLenInput:12,useLocationInput:true,useStructInput:true,useLiqInput:true,useFvgInput:true,recencyInput:15,cooldownInput:10,atrPeriodInput:14,slBufferAtrInput:.5,rrRatioInput:2,showEmaInput:true,showFvgInput:true,showZonesInput:true},[num('emaFastInput','Fast EMA',1,undefined,true),num('emaSlowInput','Slow EMA',2,undefined,true),bool('useTrendInput','Trend Filter'),num('swingLenInput','Swing Width',2,undefined,true),bool('useLocationInput','Location Filter'),bool('useStructInput','CHoCH Filter'),bool('useLiqInput','Sweep Filter'),bool('useFvgInput','FVG Filter'),num('recencyInput','Confluence Window',1,100,true),num('cooldownInput','Cooldown',0,200,true),num('atrPeriodInput','ATR',2,100,true),num('slBufferAtrInput','SL Buffer ATR',0,5),num('rrRatioInput','Risk Reward',.5,10),bool('showEmaInput','Show EMA'),bool('showFvgInput','Show FVG'),bool('showZonesInput','Premium/Discount')],['ohlcv']),
 definition('liquidity-hunt-pro','Liquidity Hunt Pro',{swingLen:5,confirmBars:10,atrLen:14,minBodyATR:.15,freshShift:true,signalGap:10,rr1:1,rr2:2,rr3:3,stopAtHit:true,strictSweeps:false,showOB:true,obLookback:15,showFVG:true,extendBars:30,zoneMitigation:'closeThrough',useTrendFilter:false,showEMAs:true},[num('swingLen','Swing Width',2,undefined,true),num('confirmBars','Max Bars After Sweep',1,undefined,true),num('atrLen','ATR',1,undefined,true),num('minBodyATR','Body ATR',0),bool('freshShift','Fresh Shift'),num('signalGap','Signal Gap',0,undefined,true),num('rr1','TP1 R',.5),num('rr2','TP2 R',1),num('rr3','TP3 R',1.5),bool('stopAtHit','End at Stop/Target'),bool('strictSweeps','Ignore Broken Levels'),bool('showOB','Order Blocks'),num('obLookback','OB Lookback',2,50,true),bool('showFVG','FVG'),num('extendBars','Zone Extension',5,200,true),select('zoneMitigation','Mitigation',['wickThrough','closeThrough','never']),bool('useTrendFilter','Trend Filter'),bool('showEMAs','EMA 50/200')]),
 definition('ma-confluence-engine','MA Confluence Engine',{maType:'EMA',baseLen:10,stepLen:8,srcInput:'close',...maDefaults,bullTh:75,bearTh:25,useWidth:true,minWidth:.8,useRegime:true,erLen:20,erMin:.3,dirInput:'Both',slMode:'ATR',atrLen:14,slVal:2.5,tp1R:1,tp2R:2,tp3R:3,showRibbon:true},[select('maType','MA Type',MA_TYPES),num('baseLen','Fastest Length',2,undefined,true),num('stepLen','Ribbon Step',1,undefined,true),select('srcInput','Source',sourceOptions),...maParams,num('bullTh','Bull Consensus',50,100,true),num('bearTh','Bear Consensus',0,50,true),bool('useWidth','Width Filter'),num('minWidth','Minimum ATR Width',0),bool('useRegime','Efficiency Filter'),num('erLen','ER Window',2,undefined,true),num('erMin','Min Efficiency',0,1),select('dirInput','Direction',['Both','Longs Only','Shorts Only']),select('slMode','SL Unit',['ATR','Percent']),num('atrLen','ATR',1,undefined,true),num('slVal','Stop Distance',.1),num('tp1R','TP1 R',.1),num('tp2R','TP2 R',.1),num('tp3R','TP3 R',.1),bool('showRibbon','Show Ribbon')],['ohlcv']),
 definition('market-os','MARKET OS',{presetInput:'Default',kamaLenInput:10,pivotInput:10,erSmoothInput:3,erTrendInput:.4,erChopInput:.2,effHiInput:1.5,effLoInput:.7,resHiInput:.8,resLoInput:.3,edgeOnInput:true,edgeWinInput:100,costLookInput:250,tpAtrInput:2,scoreMinInput:55,showCGrade:false,bosReqInput:1,cooldownInput:5,showCloudInput:true},[select('presetInput','Preset',['Default','Fast','Smooth']),num('kamaLenInput','KAMA Length',2,undefined,true),num('pivotInput','Structure Width',2,50,true),num('erSmoothInput','Efficiency Smoothing',1,20,true),num('erTrendInput','Trending Threshold',.05,.95),num('erChopInput','Chop Threshold',.05,.9),num('effHiInput','High Effort',1),num('effLoInput','Low Effort',.1,1),num('resHiInput','High Result',.1),num('resLoInput','Low Result',.05),bool('edgeOnInput','Cost Engine'),num('edgeWinInput','EDGE Window',30,400,true),num('costLookInput','Cost Regime',50,1000,true),num('tpAtrInput','Target ATR',.5),num('scoreMinInput','Minimum Score',0,100,true),bool('showCGrade','C Grade'),num('bosReqInput','BOS Required',0,5,true),num('cooldownInput','Cooldown',0,50,true),bool('showCloudInput','Cloud')]),
 definition('naive-bayes-order-flow','Naive Bayes Order Flow',{classifierLookbackInput:100,entryThresholdInput:.7,priorBullInput:.5,cvdMomentumPeriodInput:14,cvdSlopePeriodInput:10,zScoreWindowInput:50,signalCooldownInput:5,requireBarCloseInput:true,useVolFilterInput:false,volLenInput:20,volMultInput:1.5,slAtrMultInput:1.5,rrRatioInput:2,atrPeriodInput:14,emaPeriodInput:50},[num('classifierLookbackInput','Classifier Warmup',30,500,true),num('entryThresholdInput','Entry Probability',.51,.95),num('priorBullInput','Prior Bull',.1,.9),num('cvdMomentumPeriodInput','CVD Momentum',3,100,true),num('cvdSlopePeriodInput','CVD Slope',3,50,true),num('zScoreWindowInput','Z Window',10,200,true),num('signalCooldownInput','Cooldown',0,100,true),bool('requireBarCloseInput','Bar Close'),bool('useVolFilterInput','Volume Filter'),num('volLenInput','Volume Window',2,200,true),num('volMultInput','Volume Surge',1,5),num('slAtrMultInput','Stop ATR',.5,5),num('rrRatioInput','Risk Reward',.5,10),num('atrPeriodInput','ATR',5,50,true),num('emaPeriodInput','Trend EMA',5,500,true)]),
 definition('pressure-flow-pro','Pressure Flow Pro',{fastLen:21,slowLen:50,showEMAs:true,minBody:.45,volLen:20,volMult:1,swingLen:20,sweepRule:'rejection',sweepClose:.6,cooldown:10,minGrade:'abOnly',atrLen:14,stopATR:1.2,rr1:1,rr2:2,stopAtHit:true},[num('fastLen','Fast EMA',1,undefined,true),num('slowLen','Slow EMA',2,undefined,true),bool('showEMAs','Show EMAs'),num('minBody','Body Ratio',.1,1),num('volLen','Volume Average',1,undefined,true),num('volMult','Relative Volume',.1),num('swingLen','Liquidity Lookback',5,undefined,true),select('sweepRule','Sweep Entry',['rejection','sameAsBreak']),num('sweepClose','Rejection Close',.5,.95),num('cooldown','Cooldown',0,undefined,true),select('minGrade','Minimum Grade',['allGrades','abOnly','aOnly']),num('atrLen','ATR',1,undefined,true),num('stopATR','Stop ATR',.1),num('rr1','TP1 R',.25),num('rr2','TP2 R',.5),bool('stopAtHit','End at Stop/Target')]),
];

function efficiency(values,length){const changes=values.map((v,i)=>i?Math.abs(v-values[i-1]):null),vol=sum(changes,length);return values.map((v,i)=>finite(vol[i])&&vol[i]!==0&&i>=length?Math.abs(v-values[i-length])/vol[i]:0);}
function kama(values,length,fast=2,slow=30){const er=efficiency(values,length),out=[];for(let i=0;i<values.length;i++){const sc=(er[i]*(2/(fast+1)-2/(slow+1))+2/(slow+1))**2,prev=finite(out[i-1])?out[i-1]:values[i];out.push(prev+sc*(values[i]-prev));}return out;}
export function nativeMA(type,values,length,bars,options={}){
 const p={...maDefaults,...options};
 if(type==='SMA')return sma(values,length);
 if(type==='EMA')return ema(values,length);
 if(type==='WMA')return wma(values,length);
 if(type==='RMA')return rma(values,length);
 if(type==='VWMA'){const v=field(bars,'volume'),weighted=sma(binary(values,v,(a,b)=>a*b),length),total=sma(v,length);return binary(weighted,total,(a,b)=>b? a/b:null);}
 if(type==='HMA'){const half=wma(values,Math.max(1,Math.floor(length/2))),full=wma(values,length);return wma(binary(half,full,(a,b)=>2*a-b),Math.max(1,Math.round(Math.sqrt(length))));}
 if(type==='DEMA'||type==='TEMA'||type==='T3'){const e1=ema(values,length),e2=ema(e1,length),e3=ema(e2,length);if(type==='DEMA')return binary(e1,e2,(a,b)=>2*a-b);if(type==='TEMA')return e1.map((v,i)=>3*v-3*e2[i]+e3[i]);const e4=ema(e3,length),e5=ema(e4,length),e6=ema(e5,length),a=p.t3Factor;return e3.map((v,i)=>-(a**3)*e6[i]+(3*a*a+3*a**3)*e5[i]+(-6*a*a-3*a-3*a**3)*e4[i]+(1+3*a+3*a*a+a**3)*v);}
 if(type==='ALMA'){const m=p.almaOffset*(length-1),s=length/p.almaSigma;return rolling(values,length,w=>{let total=0,weight=0;for(let i=0;i<length;i++){const x=Math.exp(-((i-m)**2)/(2*s*s));total+=w[i]*x;weight+=x;}return total/weight;});}
 if(type==='KAMA')return kama(values,length,p.kamaFast,p.kamaSlow);
 if(type==='LSMA')return linreg(values,length);
 if(type==='Median')return rolling(values,length,w=>{const v=[...w].sort((a,b)=>a-b),m=Math.floor(v.length/2);return v.length%2?v[m]:(v[m-1]+v[m])/2;});
 const out=[],high=field(bars,'high'),low=field(bars,'low');let kalP=1,l0,l1,l2,l3;
 const half=Math.max(Math.floor(length/2),1),hh=highest(high,half),ll=lowest(low,half),hFull=highest(high,length),lFull=lowest(low,length);
 const mom=values.map((v,i)=>i?v-values[i-1]:null),up=sum(mom.map(v=>v>0?v:0),p.vidyaCmo),dn=sum(mom.map(v=>v<0?-v:0),p.vidyaCmo);
 for(let i=0;i<values.length;i++){
  const v=values[i],prev=finite(out[i-1])?out[i-1]:v;let next;
  if(type==='McGinley')next=i===0?v:prev+(v-prev)/(p.mcgK*length*(v/prev)**4);
  else if(type==='ZLEMA'){const a=2/(length+1),lag=Math.round((length-1)/2);next=a*(2*v-(finite(values[i-lag])?values[i-lag]:v))+(1-a)*prev;}
  else if(type==='FRAMA'){const n1=finite(hh[i])?(hh[i]-ll[i])/half:null,n2=i>=half&&finite(hh[i-half])?(hh[i-half]-ll[i-half])/half:null,n3=finite(hFull[i])?(hFull[i]-lFull[i])/length:null;const dim=n1>0&&n2>0&&n3>0?(Math.log(n1+n2)-Math.log(n3))/Math.log(2):1,a=Math.max(.01,Math.min(1,Math.exp(-4.6*(dim-1))));next=a*v+(1-a)*prev;}
  else if(type==='VIDYA'){const cmo=finite(up[i])&&finite(dn[i])&&up[i]+dn[i]!==0?Math.abs((up[i]-dn[i])/(up[i]+dn[i])):0,a=2/(length+1);next=a*cmo*v+(1-a*cmo)*prev;}
  else if(type==='SuperSmoother'){const a=Math.exp(-1.414*Math.PI/length),c2=2*a*Math.cos(1.414*Math.PI/length),c3=-a*a,c1=1-c2-c3;next=c1*(v+(values[i-1]??v))/2+c2*prev+c3*(out[i-2]??v);}
  else if(type==='Gaussian'){const beta=(1-Math.cos(2*Math.PI/length))/(1.414**(2/p.gaussPoles)-1),a=-beta+Math.sqrt(beta*beta+2*beta),o=1-a;next=a**p.gaussPoles*v;for(let k=1;k<=p.gaussPoles;k++){const coefficient=[[],[1],[2,1],[3,3,1],[4,6,4,1]][p.gaussPoles][k-1];next+=(k%2?1:-1)*coefficient*o**k*(out[i-k]??v);}}
  else if(type==='Laguerre'){const a=l0??v,b=l1??v,c=l2??v,d=l3??v,g=p.lagGamma;l0=(1-g)*v+g*a;l1=-g*l0+a+g*b;l2=-g*l1+b+g*c;l3=-g*l2+c+g*d;next=(l0+2*l1+2*l2+l3)/6;}
  else if(type==='Kalman'){if(i===0)next=v;else{const pp=kalP+p.kalQ,k=pp/(pp+p.kalR);next=prev+k*(v-prev);kalP=(1-k)*pp;}}
  else throw Error('未移植的MA类型：'+type);
  out.push(finite(next)?next:null);
 }
 return out;
}
function percentile(values,length){return values.map((value,i)=>{if(!finite(value)||i<length-1)return null;const window=values.slice(i-length+1,i+1);return window.every(finite)?100*window.filter(v=>v<=value).length/length:null;});}
export function edgeEstimate(bars,length,signed=false){
 return bars.map((_,index)=>{
  if(index<=length+1)return null;
  const rows=[];let s1=0,s3=0,s5=0,st=0,spo=0,spc=0;
  for(let k=0;k<length;k++){const b=bars[index-k],prev=bars[index-k-1];if(!b||!prev||[b.open,b.high,b.low,b.close,prev.high,prev.low,prev.close].some(v=>!finite(v)||v<=0))continue;
   const o=Math.log(b.open),h=Math.log(b.high),l=Math.log(b.low),c1=Math.log(prev.close),m=(h+l)/2,m1=(Math.log(prev.high)+Math.log(prev.low))/2;
   const r=[m-o,o-m1,m-c1,c1-m1,o-c1],tau=b.high!==b.low||b.low!==prev.close?1:0;
   rows.push([...r,tau]);s1+=r[0];s3+=r[2];s5+=r[4];st+=tau;spo+=tau*((b.open!==b.high?1:0)+(b.open!==b.low?1:0));spc+=tau*((prev.close!==prev.high?1:0)+(prev.close!==prev.low?1:0));
  }
  const n=rows.length;if(n<3||st<2||spo<=0||spc<=0)return null;
  const pt=st/n,po=spo/n,pc=spc/n,m1=s1/n,m3=s3/n,m5=s5/n;let sx1=0,sx2=0,sq1=0,sq2=0;
  for(const [r1,r2,r3,r4,r5,tau] of rows){const d1=r1-m1/pt*tau,d3=r3-m3/pt*tau,d5=r5-m5/pt*tau,x1=-4/po*d1*r2-4/pc*d3*r4,x2=-4/po*d1*r5-4/pc*d5*r4;sx1+=x1;sx2+=x2;sq1+=x1*x1;sq2+=x2*x2;}
  const e1=sx1/n,e2=sx2/n,v1=sq1/n-e1*e1,v2=sq2/n-e2*e2,vt=v1+v2,s2=vt>0?(v2*e1+v1*e2)/vt:(e1+e2)/2;
  return Math.sqrt(Math.abs(s2))*(signed?Math.sign(s2):1);
 });
}
const grade=(score,a,b)=>score>=a?'A':score>=b?'B':'C';
const gradeOK=(g,min)=>min==='allGrades'||g==='A'||min==='abOnly'&&g==='B';
function plot(out,name,values){
 const units={'ADX':'0–100','Trend State':'−1/0/1'};
 const oscillator=/score|strength|consensus|width ATR|efficiency|percentile|EDGE|^P |accuracy|CVD|confluence|Quality|Market State|^ADX$|^Trend State$/i.test(name);
 out.plots.push({name,values,pane:oscillator?'oscillator':'price',...(units[name]?{unit:units[name]}:{})});
}
function signal(out,bars,index,side,entry,stop,target,label,extra={}){out.signals.push({index,time:bars[index].time,side,entry:finite(entry)?entry:null,stop:finite(stop)?stop:null,target:finite(target)?target:null,label,...extra});}
function absorption(bars,p,context,out){
 const close=field(bars,'close'),a=atr(bars,14),e=ema(close,p.emaLength),vol=sma(field(bars,'volume'),p.volLength),priorH=highest(shift(field(bars,'high')),p.rangeLength),priorL=lowest(shift(field(bars,'low')),p.rangeLength),scoresB=[],scoresS=[];let last=-Infinity,bull=null,bear=null;
 for(let i=0;i<bars.length;i++){
  const b=bars[i],range=Math.max(b.high-b.low,context.mintick),lower=(Math.min(b.open,b.close)-b.low)/range,upper=(b.high-Math.max(b.open,b.close))/range,pos=(b.close-b.low)/range;
  const valid=finite(vol[i])&&vol[i]>0,rel=valid?b.volume/vol[i]:null,effort=valid?Math.min(rel/3,1):0,sB=Math.round(100*(.4*effort+.3*lower+.3*pos)),sS=Math.round(100*(.4*effort+.3*upper+.3*(1-pos)));scoresB.push(valid?sB:null);scoresS.push(valid?sS:null);
  const spike=valid&&b.volume>=vol[i]*p.volMultiplier,bs=finite(priorL[i])&&b.low<priorL[i]&&b.close>priorL[i],ss=finite(priorH[i])&&b.high>priorH[i]&&b.close<priorH[i];
  const buy=spike&&lower>=p.wickRatio&&pos>=.6&&(!p.useTrendFilter||b.close>e[i])&&(!p.useSweepFilter||bs)&&gradeOK(grade(sB,75,65),p.minGrade)&&i-last>p.cooldown;
  const sell=spike&&upper>=p.wickRatio&&pos<=.4&&(!p.useTrendFilter||b.close<e[i])&&(!p.useSweepFilter||ss)&&gradeOK(grade(sS,75,65),p.minGrade)&&i-last>p.cooldown;
  if(buy||sell){last=i;const side=buy?'long':'short',direction=buy?1:-1,risk=finite(a[i])?Math.max(a[i]*p.targetATR,context.mintick):null;signal(out,bars,i,side,b.close,finite(risk)?b.close-direction*risk:null,finite(risk)?b.close+direction*risk*p.targetRR1:null,(buy?'BUY ':'SELL ')+grade(buy?sB:sS,75,65),{score:buy?sB:sS,targets:finite(risk)?[p.targetRR1,p.targetRR2,p.targetRR3].map(r=>b.close+direction*risk*r):[]});
   if(p.showZones){const z={startIndex:i,endIndex:i+p.zoneExtension,low:buy?b.low:Math.min(b.open,b.close),high:buy?Math.max(b.open,b.close):b.high,label:buy?'BUYER ABSORPTION':'SELLER ABSORPTION',state:'live',knownIndex:i,left:false};if(buy){out.zones=out.zones.filter(old=>old!==bull);bull=z;}else{out.zones=out.zones.filter(old=>old!==bear);bear=z;}out.zones.push(z);}
  }
  if(p.zoneMode==='track')for(const [z,d] of [[bull,1],[bear,-1]]){
   if(!z||z.state==='failed'||i<=z.startIndex)continue;
   if(d===1?b.close<z.low:b.close>z.high){z.state='failed';z.endIndex=i;z.label+=' · FAILED';}
   else if(d===1?b.low>z.high:b.high<z.low)z.left=true;
   else if(z.left){z.left=false;z.state='retested';z.label=z.label.replace(' · RETESTED','')+' · RETESTED';}
  }
 }
 if(p.zoneMode==='track')for(const z of [bull,bear])if(z&&z.state!=='failed')z.endIndex=bars.length-1+p.zoneExtension;
 if(p.showEMA)plot(out,'Trend EMA',e);plot(out,'Bull absorption score',scoresB);plot(out,'Bear absorption score',scoresS);
 out.notes.push('OHLCV proxy：原Pine以相对成交量、影线和收盘位置估算吸收，不是逐笔买卖或主力身份。');
}
function pressure(bars,p,context,out){
 const c=field(bars,'close'),fast=ema(c,p.fastLen),slow=ema(c,p.slowLen),a=atr(bars,p.atrLen),v=sma(field(bars,'volume'),p.volLen),h=highest(shift(field(bars,'high')),p.swingLen),l=lowest(shift(field(bars,'low')),p.swingLen),bullScores=[],bearScores=[];let last=-Infinity;
 for(let i=0;i<bars.length;i++){
  const b=bars[i],r=Math.max(b.high-b.low,context.mintick),body=Math.abs(b.close-b.open)/r,bp=(b.close-b.low)/r,sp=(b.high-b.close)/r,bt=fast[i]>slow[i]&&b.close>fast[i],st=fast[i]<slow[i]&&b.close<fast[i];
  const lb=finite(h[i])&&b.close>h[i]&&bt&&b.close>b.open&&body>=p.minBody,sb=finite(l[i])&&b.close<l[i]&&st&&b.close<b.open&&body>=p.minBody;
  const ls=finite(l[i])&&b.low<l[i]&&b.close>l[i]&&(p.sweepRule==='rejection'?fast[i]>slow[i]&&b.close>b.open&&bp>=p.sweepClose:bt&&b.close>b.open&&body>=p.minBody);
  const ss=finite(h[i])&&b.high>h[i]&&b.close<h[i]&&(p.sweepRule==='rejection'?fast[i]<slow[i]&&b.close<b.open&&sp>=p.sweepClose:st&&b.close<b.open&&body>=p.minBody);
  const has=finite(v[i])&&v[i]>0,rel=has?b.volume/v[i]:null,vs=has?Math.min(rel/2,1):0,bs=ls&&!lb?(Math.min(b.open,b.close)-b.low)/r:body,sst=ss&&!sb?(b.high-Math.max(b.open,b.close))/r:body;
  const scoreB=Math.round(has?100*(.35*bs+.35*bp+.3*vs):100*(.5*bs+.5*bp)),scoreS=Math.round(has?100*(.35*sst+.35*sp+.3*vs):100*(.5*sst+.5*sp));bullScores.push(scoreB);bearScores.push(scoreS);
  const vok=!finite(v[i])||b.volume>=v[i]*p.volMult,buy=(lb||ls)&&vok&&gradeOK(grade(scoreB,85,70),p.minGrade)&&i-last>p.cooldown,sell=(sb||ss)&&vok&&gradeOK(grade(scoreS,85,70),p.minGrade)&&i-last>p.cooldown;
  if(buy||sell){last=i;const d=buy?1:-1,stop=finite(a[i])?(buy?Math.min(b.low,b.close-a[i]*p.stopATR):Math.max(b.high,b.close+a[i]*p.stopATR)):null,risk=finite(stop)?Math.max(Math.abs(b.close-stop),context.mintick):null,trigger=(buy?lb:sb)?(buy?ls:ss)?'BREAK + SWEEP':'BREAK':'SWEEP';signal(out,bars,i,buy?'long':'short',b.close,stop,finite(risk)?b.close+d*risk*p.rr1:null,(buy?'BUY ':'SELL ')+grade(buy?scoreB:scoreS,85,70)+' · '+trigger,{score:buy?scoreB:scoreS,targets:finite(risk)?[p.rr1,p.rr2].map(r=>b.close+d*risk*r):[]});}
 }
 if(p.showEMAs){plot(out,'Fast EMA',fast);plot(out,'Slow EMA',slow);}plot(out,'Bull pressure score',bullScores);plot(out,'Bear pressure score',bearScores);
 out.notes.push('OHLCV proxy：压力分数是K线实体、影线、收盘位置及相对成交量的原公式，不是资金净流入。');
}
function apex(bars,p,context,out){
 const c=field(bars,'close'),h=field(bars,'high'),l=field(bars,'low'),src=source(bars,p.srcIn),opt={almaOffset:p.almaOff,almaSigma:p.almaSig,t3Factor:p.t3Fac,kamaFast:p.kamaF,kamaSlow:p.kamaS};
 const base=nativeMA(p.maType,src,p.trendLen,bars,opt),fast=nativeMA(p.maType,src,p.fastLen,bars,opt),a=atr(bars,14),d=adx(bars,14,14),rise=rising(base,2),fall=falling(base,2),hi=highest(h,p.rangeLen),lo=lowest(l,p.rangeLen),eq=binary(hi,lo,(x,y)=>(x+y)/2),basis=sma(c,p.extLen),sd=stdev(c,p.extLen),lower=binary(basis,sd,(x,y)=>x-1.5*y),upper=binary(basis,sd,(x,y)=>x+1.5*y);
 const cloud=n=>p.cloudType==='Donchian'?binary(highest(h,n),lowest(l,n),(x,y)=>(x+y)/2):nativeMA(p.cloudType,bars.map(b=>(b.high+b.low)/2),n,bars,opt),tenkan=cloud(9),kijun=cloud(26),senA=binary(tenkan,kijun,(x,y)=>(x+y)/2),senB=cloud(52),st=supertrend(bars,p.stFactor,p.stAtr);
 const er=efficiency(c,20),delta=binary(c,base,(x,y)=>x-y),dist=binary(delta,a,(x,y)=>y?x/y:null),slope=base.map((v,i)=>i&&finite(v)&&finite(base[i-1])&&a[i]>0?(v-base[i-1])/a[i]:null);
 const minmax=values=>{const low=lowest(values,200),high=highest(values,200);return values.map((v,i)=>finite(v)&&finite(low[i])&&finite(high[i])?(v-low[i])/Math.max(high[i]-low[i],context.mintick):null);},f1=minmax(dist),f2=minmax(slope),e10=ema(c,10),e30=ema(c,30),e60=ema(c,60),strength=c.map((v,i)=>finite(f1[i])&&finite(f2[i])&&finite(d.adx[i])?(.25*f1[i]+.2*f2[i]+.2*Math.min(d.adx[i]/50,1)+.2*er[i]+.15*Math.max((e10[i]>e30[i]?1:0)+(e30[i]>e60[i]?1:0)+(v>e10[i]?1:0),(e10[i]<e30[i]?1:0)+(e30[i]<e60[i]?1:0)+(v<e10[i]?1:0))/3)*10:null);
 let last=-100000,active=0,entry=null;
 for(let i=0;i<bars.length;i++){
  const b=bars[i],trending=finite(d.adx[i])&&d.adx[i]>p.adxThr,mode=p.mode==='Auto (regime-aware)'?(trending?'TF':'MR'):p.mode==='Trend-Following'?'TF':'MR',locB=!p.useLoc||finite(eq[i])&&b.close<eq[i],locS=!p.useLoc||finite(eq[i])&&b.close>eq[i];
  const rawB=mode==='TF'?crossOver(c,base,i)&&rise[i]&&d.plusDI[i]>d.minusDI[i]&&trending&&locB:!trending&&finite(lower[i])&&b.low<=lower[i]&&crossOver(c,lower,i)&&locB;
  const rawS=mode==='TF'?crossUnder(c,base,i)&&fall[i]&&d.minusDI[i]>d.plusDI[i]&&trending&&locS:!trending&&finite(upper[i])&&b.high>=upper[i]&&crossUnder(c,upper,i)&&locS;
  const cb=!p.showCloud||i>=26&&finite(senA[i-26])&&finite(senB[i-26])&&b.close>Math.max(senA[i-26],senB[i-26]),cs=!p.showCloud||i>=26&&finite(senA[i-26])&&finite(senB[i-26])&&b.close<Math.min(senA[i-26],senB[i-26]);
  const buy=rawB&&cb&&i-last>=p.sigGap,sell=rawS&&cs&&i-last>=p.sigGap;
  if(buy||sell){last=i;active=buy?1:-1;entry=b.close;signal(out,bars,i,buy?'long':'short',entry,null,finite(a[i])?entry+active*p.tpMult*a[i]:null,buy?'Buy':'Sell',{mode});}
  if(active&&finite(a[i])&&(active===1?b.high>=entry+p.tpMult*a[i]:b.low<=entry-p.tpMult*a[i])){signal(out,bars,i,'exit',active===1?entry+p.tpMult*a[i]:entry-p.tpMult*a[i],null,null,active===1?'Buy TP':'Sell TP');active=0;}
 }
 if(p.showMid)plot(out,'Trend Midline',base);plot(out,'Fast MA',fast);plot(out,'Trend strength',strength);plot(out,'ADX',d.adx);
 if(p.showZone){plot(out,'Adaptive Zone Line',st.line);plot(out,'Zone Hi',st.line.map((v,i)=>finite(v)&&finite(a[i])?v+(st.direction[i]<0?a[i]*.5:0):null));plot(out,'Zone Lo',st.line.map((v,i)=>finite(v)&&finite(a[i])?v-(st.direction[i]<0?0:a[i]*.5):null));}
 if(p.showCloud){plot(out,'Senkou A (26-bar forward projection)',Array(26).fill(null).concat(senA).slice(0,bars.length));plot(out,'Senkou B (26-bar forward projection)',Array(26).fill(null).concat(senB).slice(0,bars.length));}
 if(p.showExt)for(const [name,m]of [['U1',1.5],['U2',2.25],['U3',3],['L1',-1.5],['L2',-2.25],['L3',-3]])plot(out,name,binary(basis,sd,(x,y)=>x+m*y));
 out.notes.push('Ichimoku投影仅按原26根位移显示；信号云层判断使用已知历史senkou[26]。TP使用当根ATR，沿用原脚本动态阈值；slMult在原码仅声明未使用，所以不编造止损、stop留空。');
}
function ribbon(bars,p,context,out){
 const c=field(bars,'close'),src=source(bars,p.srcInput),a=atr(bars,p.atrLen),er=efficiency(c,p.erLen),mas=Array.from({length:15},(_,k)=>nativeMA(p.maType,src,p.baseLen+k*p.stepLen,bars,p));
 const consensus=c.map((v,i)=>mas.reduce((n,line)=>n+(finite(line[i])&&v>line[i]?1:0)+(finite(line[i])&&finite(line[i-1])&&line[i]>line[i-1]?1:0),0)/30*100),width=c.map((_,i)=>a[i]>0&&mas.some(line=>finite(line[i]))?(Math.max(...mas.map(line=>line[i]).filter(finite))-Math.min(...mas.map(line=>line[i]).filter(finite)))/a[i]:0);
 for(let i=0;i<bars.length;i++){
  const gate=(!p.useRegime||er[i]>=p.erMin)&&(!p.useWidth||width[i]>=p.minWidth),buy=crossOver(consensus,p.bullTh,i)&&gate&&p.dirInput!=='Shorts Only',sell=crossUnder(consensus,p.bearTh,i)&&gate&&p.dirInput!=='Longs Only';
  if(buy||sell){const dir=buy?1:-1,risk=p.slMode==='ATR'?(finite(a[i])?p.slVal*a[i]:null):c[i]*p.slVal/100;signal(out,bars,i,buy?'long':'short',c[i],finite(risk)?c[i]-dir*risk:null,finite(risk)?c[i]+dir*p.tp1R*risk:null,buy?'Long Consensus':'Short Consensus',{consensus:consensus[i],targets:finite(risk)?[p.tp1R,p.tp2R,p.tp3R].map(r=>c[i]+dir*r*risk):[]});}
 }
 if(p.showRibbon)mas.forEach((values,k)=>plot(out,'MA '+(p.baseLen+k*p.stepLen)+' '+p.maType,values));plot(out,'Consensus %',consensus);plot(out,'Ribbon width ATR',width);plot(out,'Efficiency ratio',er);
}
function edge(bars,p,context,out){const estimate=edgeEstimate(bars,p.winInput,p.signedInput),unit=p.unitInput==='Basis Points'?10000:100,raw=map(estimate,v=>v*unit),smooth=ema(raw,p.smoothInput),rank=percentile(smooth,p.regimeLenInput);plot(out,'EDGE Spread '+(unit===10000?'bps':'%'),smooth);if(p.showRawInput)plot(out,'Raw EDGE Spread',raw);plot(out,'Cost percentile',rank);out.notes.push('OHLC估计的有效买卖价差，不是实际盘口报价或可成交点差；原双遍矩条件和方差最优加权公式保留。');}
function marketOS(bars,p,context,out){
 const c=field(bars,'close'),n=p.presetInput==='Fast'?6:p.presetInput==='Smooth'?16:p.kamaLenInput,pivot=p.presetInput==='Fast'?5:p.presetInput==='Smooth'?15:p.pivotInput,slow=p.presetInput==='Fast'?20:p.presetInput==='Smooth'?40:30,k=kama(c,n,2,slow),er=sma(efficiency(c,n),p.erSmoothInput),a=atr(bars,14),v=sma(field(bars,'volume'),20),ph=pivots(field(bars,'high'),pivot,pivot,'high'),pl=pivots(field(bars,'low'),pivot,pivot,'low'),edge=p.edgeOnInput?edgeEstimate(bars,p.edgeWinInput):bars.map(()=>null),cost=percentile(map(edge,x=>x*10000),p.costLookInput),score=[],states=[],highs=[],lows=[];
 let lastHigh=null,lastLow=null,highBar=null,lowBar=null,trend=0,bullBos=0,bearBos=0,lastSignal=-9999;
 for(let i=0;i<bars.length;i++){
  const b=bars[i],bullBreak=finite(lastHigh)&&i>0&&b.close>lastHigh&&finite(highs[i-1])&&c[i-1]<=highs[i-1],bearBreak=finite(lastLow)&&i>0&&b.close<lastLow&&finite(lows[i-1])&&c[i-1]>=lows[i-1];let up=false,down=false;
  if(bullBreak){if(trend===1)bullBos++;else if(bearBos>=p.bosReqInput){up=true;trend=1;bullBos=0;bearBos=0;}}
  if(bearBreak&&!bullBreak){if(trend===-1)bearBos++;else if(bullBos>=p.bosReqInput){down=true;trend=-1;bullBos=0;bearBos=0;}}
  if(up||down)out.zones.push({startIndex:up?highBar:lowBar,endIndex:i,low:up?lastHigh:lastLow,high:up?lastHigh:lastLow,label:up?'CHoCH ↑':'CHoCH ↓',knownIndex:i});
  if(out.zones.length>6)out.zones.shift();
  if(ph[i]){lastHigh=ph[i].value;highBar=ph[i].index;}if(pl[i]){lastLow=pl[i].value;lowBar=pl[i].index;}highs.push(lastHigh);lows.push(lastLow);
  const bullish=b.close>k[i],eff=v[i]>0?b.volume/v[i]:0,result=a[i]>0&&i?Math.abs(b.close-c[i-1])/a[i]:0,conv=eff>=p.effHiInput&&result>=p.resHiInput?1:eff>=p.effHiInput&&result<=p.resLoInput?2:eff<=p.effLoInput&&result>=p.resHiInput?3:0;
  const dirScore=trend===1&&bullish||trend===-1&&!bullish?100:trend!==0?50:30,qual=finite(er[i])?Math.min(er[i]/p.erTrendInput,1)*100:null,part=conv===1?100:conv===0?60:conv===3?35:10,costScore=finite(cost[i])?100-cost[i]:50,s=finite(qual)?dirScore*.3+qual*.3+part*.25+costScore*.15:null;
  score.push(s);states.push(finite(s)?s>=75?3:s>=55?2:s>=35?1:0:null);const g=grade(s,75,55),ok=i-lastSignal>=p.cooldownInput&&(finite(s)&&s>=p.scoreMinInput||p.showCGrade)&&(g!=='C'||p.showCGrade),buy=up&&bullish&&ok,sell=down&&!bullish&&ok;
  if(buy||sell){lastSignal=i;signal(out,bars,i,buy?'long':'short',b.close,null,null,(buy?'LONG ':'SHORT ')+'['+g+']',{score:s,costBps:finite(edge[i])?edge[i]*10000:null,costOfTargetPct:finite(edge[i])&&a[i]>0?edge[i]*b.close/(a[i]*p.tpAtrInput)*100:null});}
 }
 plot(out,'KAMA Baseline',k);plot(out,'Market Score',score);plot(out,'Market State',states);plot(out,'Efficiency',er);plot(out,'EDGE Spread bps',map(edge,v=>v*10000));if(p.showCloudInput)for(const [name,m]of [['Cloud Inner Up',.5],['Cloud Inner Dn',-.5],['Cloud Outer Up',1.1],['Cloud Outer Dn',-1.1]])plot(out,name,binary(k,a,(x,y)=>x+m*y));
 out.notes.push('OHLCV proxy：成交量参与度与EDGE有效价差均为原公式估算。原指标没有止损或明确入场成交模型，stop/target留空。');
 if(p.bosReqInput>0)out.notes.push('保留源代码初始化：structTrend初始0且BOS计数仅在已有方向时增加；BOS Required>0可能使首次结构翻转始终无法初始化，不替作者放宽规则。');
}
function bayes(bars,p,context,out){
 const c=field(bars,'close'),cvd=[];let total=0;for(const b of bars){total+=b.volume*((b.close-b.low)-(b.high-b.close))/(b.high-b.low+context.mintick);cvd.push(total);}
 const momentum=p.cvdMomentumPeriodInput,roc=cvd.map((v,i)=>i>=momentum?(v-cvd[i-momentum])/(Math.abs(cvd[i-momentum])+context.mintick):null),price=c.map((v,i)=>i>=momentum?(v-c[i-momentum])/(c[i-momentum]+context.mintick):null),raw2=binary(price,roc,(x,y)=>x-y),slope=binary(linreg(cvd,p.cvdSlopePeriodInput),linreg(cvd,p.cvdSlopePeriodInput,1),(x,y)=>x-y);
 const z=values=>{const m=sma(values,p.zScoreWindowInput),sd=stdev(values,p.zScoreWindowInput);return values.map((v,i)=>sd[i]>0?(v-m[i])/sd[i]:0);},features=[z(roc),z(raw2),z(slope)],cls=c.map((v,i)=>price[i]>0&&roc[i]>0?0:price[i]<0&&roc[i]<0?1:2),counts=[0,0,0],sums=Array.from({length:3},()=>[0,0,0]),squares=Array.from({length:3},()=>[0,0,0]),post=[[],[],[]],emaLine=ema(c,p.emaPeriodInput),a=atr(bars,p.atrPeriodInput),avgVol=sma(field(bars,'volume'),p.volLenInput),accuracy=[];
 let last=-100000,prevLong=false,prevShort=false,prevPrediction=null,hits=0,evals=0;
 for(let i=0;i<bars.length;i++){
  if(i>=p.zScoreWindowInput+momentum+2){const cl=cls[i-1];counts[cl]++;for(let f=0;f<3;f++){const x=features[f][i-1];sums[cl][f]+=x;squares[cl][f]+=x*x;}}
  const n=counts.reduce((x,y)=>x+y,0),priors=n?counts.map(v=>v/n):[p.priorBullInput,(1-p.priorBullInput)/2,(1-p.priorBullInput)/2],lik=counts.map((count,cl)=>features.reduce((prod,values,f)=>{const mean=count?sums[cl][f]/count:0,sd=count>=2?Math.sqrt(Math.max(squares[cl][f]/count-mean*mean,.0001)):1,scale=Math.max(sd,.0001),x=values[i];return prod*Math.exp(-.5*((x-mean)/scale)**2)/(scale*Math.sqrt(2*Math.PI));},1)),evidence=priors.reduce((v,prior,cl)=>v+prior*lik[cl],0)+1e-12,prob=priors.map((prior,cl)=>prior*lik[cl]/evidence),warm=n>=p.classifierLookbackInput;
  prob.forEach((v,cl)=>post[cl].push(v));const prediction=prob[0]>=prob[1]&&prob[0]>=prob[2]?0:prob[1]>=prob[2]?1:2;
  if(warm&&prevPrediction!==null){evals++;if(prevPrediction===cls[i])hits++;}accuracy.push(evals?hits/evals:0);prevPrediction=prediction;
  const long=warm&&prob[0]>=p.entryThresholdInput&&c[i]>emaLine[i]&&i>0&&cvd[i]>cvd[i-1],short=warm&&prob[1]>=p.entryThresholdInput&&c[i]<emaLine[i]&&i>0&&cvd[i]<cvd[i-1],volOK=!p.useVolFilterInput||finite(avgVol[i])&&bars[i].volume>avgVol[i]*p.volMultInput,gap=p.signalCooldownInput===0||i-last>=p.signalCooldownInput,buy=long&&!prevLong&&volOK&&gap,sell=short&&!prevShort&&volOK&&gap;
  if(buy||sell){last=i;const d=buy?1:-1,risk=finite(a[i])?a[i]*p.slAtrMultInput:null;signal(out,bars,i,buy?'long':'short',c[i],finite(risk)?c[i]-d*risk:null,finite(risk)?c[i]+d*risk*p.rrRatioInput:null,buy?'NBOF Bull':'NBOF Bear',{posterior:prob[buy?0:1],trainedSamples:n});}prevLong=long;prevShort=short;
 }
 plot(out,'CVD proxy',cvd);plot(out,'P Bull',post[0]);plot(out,'P Bear',post[1]);plot(out,'P Diverged',post[2]);plot(out,'Classifier accuracy',accuracy);plot(out,'EMA',emaLine);
 out.notes.push('OHLCV proxy：CVD按收盘在高低区间的位置分配成交量，不是逐笔买卖差。训练累积历史，Classifier Lookback是暖机阈值，不是滚动删除窗口；只训练前一根已知标签。仅处理已收盘K。');
}
function equilibrium(bars,p,context,out){
 const c=field(bars,'close'),fast=ema(c,p.emaFastInput),slow=ema(c,p.emaSlowInput),a=atr(bars,p.atrPeriodInput),ph=pivots(field(bars,'high'),p.swingLenInput,p.swingLenInput,'high'),pl=pivots(field(bars,'low'),p.swingLenInput,p.swingLenInput,'low'),hs=[],ls=[],eq=[],fib236=[],fib786=[],bscores=[],sscores=[];
 let h=null,l=null,hb=null,lb=null,dir=0,last=-100000,prevB=false,prevS=false,bf=null,sf=null;const events={bullCH:null,bearCH:null,bullSweep:null,bearSweep:null,bullFvg:null,bearFvg:null};
 for(let i=0;i<bars.length;i++){
  const b=bars[i];if(ph[i]){h=ph[i].value;hb=ph[i].index;}if(pl[i]){l=pl[i].value;lb=pl[i].index;}hs.push(h);ls.push(l);const range=finite(h)&&finite(l)&&h>l,e=range?(h+l)/2:null;eq.push(e);fib236.push(range?l+(h-l)*.236:null);fib786.push(range?l+(h-l)*.786:null);
  const up=crossOver(c,hs,i),down=crossUnder(c,ls,i);if(up){if(dir<=0)events.bullCH=i;dir=1;}if(down){if(dir>=0)events.bearCH=i;dir=-1;}
  if(finite(l)&&b.low<l&&b.close>l)events.bullSweep=i;if(finite(h)&&b.high>h&&b.close<h)events.bearSweep=i;
  if(i>=2&&b.low>bars[i-2].high){events.bullFvg=i;bf={startIndex:i-2,endIndex:i,low:bars[i-2].high,high:b.low,label:'Bullish FVG',knownIndex:i};if(p.showFvgInput)out.zones.push(bf);}
  if(i>=2&&b.high<bars[i-2].low){events.bearFvg=i;sf={startIndex:i-2,endIndex:i,low:b.high,high:bars[i-2].low,label:'Bearish FVG',knownIndex:i};if(p.showFvgInput)out.zones.push(sf);}if(bf)bf.endIndex=i;if(sf)sf.endIndex=i;
  const recent=k=>events[k]!==null&&i-events[k]<=p.recencyInput,inB=bf&&b.close>=bf.low&&b.close<=bf.high,inS=sf&&b.close>=sf.low&&b.close<=sf.high;
  const B=[!p.useTrendInput||fast[i]>slow[i],!p.useLocationInput||range&&b.close<e,!p.useStructInput||recent('bullCH'),!p.useLiqInput||recent('bullSweep'),!p.useFvgInput||inB||recent('bullFvg')],S=[!p.useTrendInput||fast[i]<slow[i],!p.useLocationInput||range&&b.close>e,!p.useStructInput||recent('bearCH'),!p.useLiqInput||recent('bearSweep'),!p.useFvgInput||inS||recent('bearFvg')];
  const alignedB=B.every(Boolean),alignedS=S.every(Boolean),gap=p.cooldownInput===0||i-last>=p.cooldownInput,buy=alignedB&&!prevB&&gap,sell=alignedS&&!prevS&&gap;bscores.push(B.filter(Boolean).length);sscores.push(S.filter(Boolean).length);
  if(buy||sell){last=i;const d=buy?1:-1,stop=finite(a[i])?(buy?(finite(l)?l:b.low)-a[i]*p.slBufferAtrInput:(finite(h)?h:b.high)+a[i]*p.slBufferAtrInput):null;signal(out,bars,i,buy?'long':'short',b.close,stop,finite(stop)?b.close+d*Math.abs(b.close-stop)*p.rrRatioInput:null,buy?'BUY 5/5':'SELL 5/5');}prevB=alignedB;prevS=alignedS;
 }
 if(p.showEmaInput){plot(out,'Fast EMA',fast);plot(out,'Slow EMA',slow);}plot(out,'Equilibrium',eq);plot(out,'Fib 0.236',fib236);plot(out,'Fib 0.786',fib786);plot(out,'Buy confluence',bscores);plot(out,'Sell confluence',sscores);
 if(p.showZonesInput&&finite(eq.at(-1))){out.zones.push({startIndex:Math.min(hb,lb),endIndex:bars.length+4,low:l,high:eq.at(-1),label:'Discount',knownIndex:bars.length-1},{startIndex:Math.min(hb,lb),endIndex:bars.length+4,low:eq.at(-1),high:h,label:'Premium',knownIndex:bars.length-1});}
 out.notes.push('保留原FVG行为：最近缺口记录未在价格穿越后清空；“近期事件或当前落在缺口内”均可满足原FVG条件。');
}
function eliteFlow(bars,p,context,out){
 const c=field(bars,'close'),fast=ema(c,Math.round(p.trend_sensitivity*.5)),slow=ema(c,p.trend_sensitivity),ma=p.trend_type==='Fast'?fast:p.trend_type==='Adaptive'?binary(fast,slow,(x,y)=>(x+y)/2):nativeMA('HMA',c,p.trend_sensitivity,bars),a=atr(bars,14),v=sma(field(bars,'volume'),20),ph=pivots(field(bars,'high'),p.zone_strength,p.zone_strength,'high'),pl=pivots(field(bars,'low'),p.zone_strength,p.zone_strength,'low'),upper=binary(ma,a,(x,y)=>x+y*p.cloud_multiplier),lower=binary(ma,a,(x,y)=>x-y*p.cloud_multiplier),strengths=[],states=[];
 let trend=0,strength=0,gap=0,premium=[],discount=[];
 for(let i=0;i<bars.length;i++){
  const b=bars[i];if(finite(upper[i])&&b.close>upper[i]){trend=1;strength=Math.min(strength+1,10);}else if(finite(lower[i])&&b.close<lower[i]){trend=-1;strength=Math.max(strength-1,-10);}else strength=Math.floor(strength*.8+.5);strengths.push(strength);states.push(trend);
  if(p.detect_zones&&ph[i]){const pivot=bars[ph[i].index];premium.push({startIndex:ph[i].index,endIndex:i+50,low:Math.min(pivot.open,pivot.close),high:pivot.high,label:'PREMIUM',knownIndex:i});if(premium.length>10)premium.shift();}
  if(p.detect_zones&&pl[i]){const pivot=bars[pl[i].index];discount.push({startIndex:pl[i].index,endIndex:i+50,low:pivot.low,high:Math.max(pivot.open,pivot.close),label:'DISCOUNT',knownIndex:i});if(discount.length>10)discount.shift();}
  // The Pine source intentionally manages zones only on barstate.islast, before rejection tests.
  if(i===bars.length-1&&p.auto_extend){premium=premium.filter(z=>b.close<=z.low);discount=discount.filter(z=>b.close>=z.high);for(const z of [...premium,...discount])z.endIndex=i+20;}
  const range=b.high-b.low,body=Math.abs(b.close-b.open),strongB=b.close>b.open&&body>range*.7,strongS=b.close<b.open&&body>range*.7,rejB=p.show_rejections&&discount.some(z=>b.low<=z.low&&b.close>z.low&&strongB),rejS=p.show_rejections&&premium.some(z=>b.high>=z.high&&b.close<z.high&&strongS),volumeOK=!p.use_volume||finite(v[i])&&b.volume>v[i]*p.volume_threshold,baseB=rejB&&trend===1&&volumeOK,baseS=rejS&&trend===-1&&volumeOK,confirmedB=baseB&&(!p.use_confirmation||i>0&&b.close>c[i-1]),confirmedS=baseS&&(!p.use_confirmation||i>0&&b.close<c[i-1]);
  const buy=p.signal_mode==='Aggressive'?baseB&&gap>5:p.signal_mode==='Balanced'?baseB&&b.close>ma[i]&&gap>8:confirmedB&&strength>3&&gap>12,sell=p.signal_mode==='Aggressive'?baseS&&gap>5:p.signal_mode==='Balanced'?baseS&&b.close<ma[i]&&gap>8:confirmedS&&strength< -3&&gap>12;
  if(buy||sell){gap=0;const d=buy?1:-1;signal(out,bars,i,buy?'long':'short',b.close,finite(a[i])?b.close-d*a[i]:null,finite(a[i])?b.close+d*a[i]*2:null,buy?'LONG ENTRY':'SHORT ENTRY');}else gap++;
 }
 out.zones.push(...premium,...discount);if(p.show_cloud){plot(out,'Upper',upper);plot(out,'Lower',lower);plot(out,'Trend Core',ma);}plot(out,'Trend State',states);plot(out,'Trend Strength',strengths);
 out.notes.push('OHLCV proxy：供需区域来自确认摆点。保留原barstate.islast清理顺序，追加新K可能改变此前末根的区域过滤/信号；末根信号非稳定历史标签，不声称完整前缀不变。');
}
function liquidityHunt(bars,p,context,out){
 const c=field(bars,'close'),a=atr(bars,p.atrLen),e50=ema(c,50),e200=ema(c,200),ph=pivots(field(bars,'high'),p.swingLen,p.swingLen,'high'),pl=pivots(field(bars,'low'),p.swingLen,p.swingLen,'low'),hSeries=[],lSeries=[];
 let h=null,l=null,hiTaken=false,loTaken=false,dir=0,bull=null,bear=null,last=-Infinity;const zones={};
 function zone(key,start,i,low,high,label,d){zones[key]={startIndex:start,endIndex:i+p.extendBars,low,high,label,knownIndex:i,side:d,state:'live'};}
 for(let i=0;i<bars.length;i++){
  const b=bars[i];if(ph[i]){h=ph[i].value;hiTaken=false;}if(pl[i]){l=pl[i].value;loTaken=false;}hSeries.push(h);lSeries.push(l);
  const sweepLow=finite(l)&&(!p.strictSweeps||!loTaken)&&b.low<l&&b.close>l,sweepHigh=finite(h)&&(!p.strictSweeps||!hiTaken)&&b.high>h&&b.close<h,up=finite(h)&&!hiTaken&&crossOver(c,hSeries,i),down=finite(l)&&!loTaken&&crossUnder(c,lSeries,i);
  if(up)dir=1;if(down)dir=-1;if(finite(h)&&!hiTaken&&b.close>h)hiTaken=true;if(finite(l)&&!loTaken&&b.close<l)loTaken=true;
  if(p.showOB&&(up||down))for(const [enabled,key,d]of [[up,'bullOB',1],[down,'bearOB',-1]])if(enabled){for(let j=1;j<=p.obLookback&&j<=i;j++){const prior=bars[i-j];if(d===1?prior.close<prior.open:prior.close>prior.open){zone(key,i-j,i,prior.low,prior.high,d===1?'Bullish OB':'Bearish OB',d);break;}}}
  if(p.showFVG&&i>=2){if(b.low>bars[i-2].high)zone('bullFVG',i-2,i,bars[i-2].high,b.low,'Bullish FVG',1);if(b.high<bars[i-2].low)zone('bearFVG',i-2,i,b.high,bars[i-2].low,'Bearish FVG',-1);}
  if(p.zoneMitigation!=='never')for(const z of Object.values(zones))if(z.state==='live'&&i>z.knownIndex){const probe=p.zoneMitigation==='wickThrough'?(z.side===1?b.low:b.high):b.close;if(z.side===1?probe<z.low:probe>z.high){z.state='mitigated';z.endIndex=i;z.label+=' · mitigated';}}
  if(sweepLow&&finite(h)){bull={stop:b.low,mss:h,index:i};bear=null;}if(sweepHigh&&finite(l)){bear={stop:b.high,mss:l,index:i};bull=null;}if(bull&&i-bull.index>p.confirmBars)bull=null;if(bear&&i-bear.index>p.confirmBars)bear=null;
  const body=Math.abs(b.close-b.open),buy=bull&&b.close>bull.mss&&(!p.freshShift||i>0&&c[i-1]<=bull.mss)&&b.close>b.open&&finite(a[i])&&body>=a[i]*p.minBodyATR&&b.close>bull.stop&&b.close-bull.stop>context.mintick&&(!p.useTrendFilter||e50[i]>e200[i])&&i-last>p.signalGap;
  const sell=bear&&b.close<bear.mss&&(!p.freshShift||i>0&&c[i-1]>=bear.mss)&&b.close<b.open&&finite(a[i])&&body>=a[i]*p.minBodyATR&&b.close<bear.stop&&bear.stop-b.close>context.mintick&&(!p.useTrendFilter||e50[i]<e200[i])&&i-last>p.signalGap;
  if(buy||sell){last=i;const d=buy?1:-1,setup=buy?bull:bear,risk=Math.abs(b.close-setup.stop);signal(out,bars,i,buy?'long':'short',b.close,setup.stop,b.close+d*risk*p.rr1,buy?'BUY · Sweep + MSS':'SELL · Sweep + MSS',{sweepIndex:setup.index,targets:[p.rr1,p.rr2,p.rr3].map(r=>b.close+d*risk*r)});if(buy)bull=null;else bear=null;}
 }
 for(const z of Object.values(zones)){if(z.state==='live')z.endIndex=bars.length-1+p.extendBars;out.zones.push(z);}if(p.showEMAs){plot(out,'EMA 50',e50);plot(out,'EMA 200',e200);}plot(out,'Liquidity High',hSeries);plot(out,'Liquidity Low',lSeries);
 out.notes.push('Swing在右侧'+p.swingLen+'根K确认时才可用于Sweep/MSS，绘图区保留原摆点位置并附knownIndex；流动性名称不代表已知真实挂单。');
}
catalog.push(definition('elite-advanced-pattern-scanner','Viprasol Elite Advanced Pattern Scanner',{
 vip_show_historical:false,vip_enable_discount:true,vip_enable_premium:true,vip_left_candles:6,vip_right_candles:4,vip_min_pattern_width:12,vip_symmetry_tolerance:1.8,vip_min_structure_length:12,vip_min_trend_depth:12,vip_trend_scan_range:55,vip_extension_factor:2.2,vip_min_quality_threshold:65,vip_symmetry_weight:32,vip_trend_weight:22,vip_volume_weight:22,vip_depth_weight:16,vip_structure_weight:16,vip_use_volatility_filter:true,vip_volatility_period:16,vip_use_momentum_filter:true,vip_momentum_period:16,vip_momentum_threshold:22,vip_use_liquidity_filter:true,vip_liquidity_period:22,vip_discount_long_mode:'Balanced',vip_discount_short_mode:'Conservative',vip_premium_short_mode:'Balanced',vip_premium_long_mode:'Conservative'},[
 bool('vip_show_historical','Historical Patterns'),bool('vip_enable_discount','Discount Pattern'),bool('vip_enable_premium','Premium Pattern'),num('vip_left_candles','Left Pivots',1,undefined,true),num('vip_right_candles','Right Pivots',1,undefined,true),num('vip_min_pattern_width','Min Pattern Width',6,undefined,true),num('vip_symmetry_tolerance','Symmetry Tolerance %',.1),num('vip_min_structure_length','Min Structure Length',6,undefined,true),num('vip_min_trend_depth','Min Trend Depth',6,undefined,true),num('vip_trend_scan_range','Trend Scan Range',1,undefined,true),num('vip_extension_factor','Extension Factor',1,5),num('vip_min_quality_threshold','Minimum Quality',0,100,true),num('vip_symmetry_weight','Symmetry Weight',0,50),num('vip_trend_weight','Trend Weight',0,50),num('vip_volume_weight','Volume Weight',0,50),num('vip_depth_weight','Depth Weight',0,50),num('vip_structure_weight','Structure Weight',0,50),bool('vip_use_volatility_filter','Volatility Filter'),num('vip_volatility_period','Volatility ATR',5,50,true),bool('vip_use_momentum_filter','Momentum Filter'),num('vip_momentum_period','ADX Period',5,50,true),num('vip_momentum_threshold','Momentum Threshold',10,50),bool('vip_use_liquidity_filter','Liquidity Filter'),num('vip_liquidity_period','Volume Average',5,100,true),...['vip_discount_long_mode','vip_discount_short_mode','vip_premium_short_mode','vip_premium_long_mode'].map(key=>select(key,key,['Conservative','Balanced','Aggressive']))],['ohlcv']));
function scanner(bars,p,context,out){
 const h=field(bars,'high'),l=field(bars,'low'),v=field(bars,'volume'),ph=pivots(h,p.vip_left_candles,p.vip_right_candles,'high'),pl=pivots(l,p.vip_left_candles,p.vip_right_candles,'low'),a=atr(bars,p.vip_volatility_period),av=sma(a,50),d=adx(bars,p.vip_momentum_period,p.vip_momentum_period),avgV=sma(v,p.vip_liquidity_period),pools={discount:[],premium:[]},current={discount:null,premium:null},qualitySeries=bars.map(()=>null);
 function quality(points,i,discount){
  const [p1,p2,p3,p4]=points,x=points.map(point=>point.price),sym=Math.abs(x[1]-x[3])/((x[1]+x[3])/2)*100,symScore=sym<=p.vip_symmetry_tolerance?p.vip_symmetry_weight*(1-sym/p.vip_symmetry_tolerance):0;
  const trendOK=finite(d.adx[i])&&d.adx[i]>=p.vip_momentum_threshold&&(discount?d.minusDI[i]>d.plusDI[i]:d.plusDI[i]>d.minusDI[i]),trendScore=p.vip_use_momentum_filter?(trendOK?p.vip_trend_weight:p.vip_trend_weight*.3):p.vip_trend_weight*.5;
  let volumeScore=p.vip_volume_weight*.5;if(p.vip_use_liquidity_filter&&i-p4.index<=5000&&i-p2.index<=5000){const ratio=avgV[i]>0?(v[p4.index]+v[p2.index])/2/avgV[i]:1;volumeScore=ratio<1?p.vip_volume_weight*(1-ratio):p.vip_volume_weight*.3;}
  const depth=discount?(x[2]>x[3]?(x[2]-x[3])/x[2]:0):(x[1]>x[2]?(x[1]-x[2])/x[1]:0),depthScore=p.vip_depth_weight*Math.min(depth*10,1),trendQuality=discount?(x[0]>x[2]?1:.5):(x[1]>x[0]?1:.5),position=discount?(x[2]-x[3])/(x[0]-x[3]):(x[1]-x[2])/(x[1]-x[0]),structureScore=p.vip_structure_weight*trendQuality*Math.min(position*2,1);
  return Math.min(symScore+trendScore+volumeScore+depthScore+structureScore,100);
 }
 function detect(i,discount,pivot){
  const name=discount?'discount':'premium',pool=pools[name],p4={index:pivot.index,price:pivot.value};pool.push(p4);if(pool.length>50)pool.shift();
  for(let j=pool.length-2;j>=0;j--){
   const p2=pool[j],dist=p4.index-p2.index,diff=Math.abs(p2.price-p4.price)/(discount?Math.min(p2.price,p4.price):Math.max(p2.price,p4.price))*100;
   if(dist<p.vip_min_pattern_width||diff>p.vip_symmetry_tolerance)continue;
   let p3=null,broken=false;for(let k=p4.index-1;k>p2.index;k--){if(!p3||(discount?h[k]>p3.price:l[k]<p3.price))p3={index:k,price:discount?h[k]:l[k]};if(discount?l[k]<Math.min(p2.price,p4.price):h[k]>Math.max(p2.price,p4.price))broken=true;}
   if(broken||!p3||!(discount?p3.price>p2.price&&p3.price>p4.price:p3.price<p2.price&&p3.price<p4.price)||p3.index-p2.index<p.vip_min_structure_length||p4.index-p3.index<p.vip_min_structure_length)continue;
   let p1=null;for(let offset=p.vip_min_trend_depth;offset<=p.vip_trend_scan_range;offset++){const index=p2.index-offset;if(index<0||i-index>5000)continue;const price=discount?h[index]:l[index];if((discount?price>p3.price:price<p3.price)&&(!p1||(discount?price>p1.price:price<p1.price)))p1={index,price};}
   if(!p1)continue;let extreme=true;for(let k=p1.index+1;k<p2.index;k++)if(discount?l[k]<p2.price:h[k]>p2.price){extreme=false;break;}if(!extreme)continue;
   if(p.vip_use_volatility_filter&&finite(a[i])&&finite(av[i])&&a[i]>av[i]*1.9)continue;if(p.vip_use_momentum_filter&&finite(d.adx[i])&&d.adx[i]<p.vip_momentum_threshold*.7)continue;
   const points=[p1,p2,p3,p4],score=quality(points,i,discount);if(!finite(score)||score<p.vip_min_quality_threshold)continue;
   const zone={startIndex:p1.index,endIndex:i,low:Math.min(...points.map(x=>x.price)),high:Math.max(...points.map(x=>x.price)),label:discount?'DISCOUNT':'PREMIUM',knownIndex:i,points,score};
   if(!p.vip_show_historical&&current[name])out.zones=out.zones.filter(z=>z!==current[name].zone);
   out.zones.push(zone);current[name]={points,score,zone,entered:false,reversed:false,start:p4.index,maxWait:Math.floor(dist*p.vip_extension_factor+.5)};qualitySeries[i]=score;break;
  }
 }
 const factor=mode=>mode==='Conservative'?.618:mode==='Balanced'?1:1.618;
 for(let i=0;i<bars.length;i++){
  if(p.vip_enable_discount&&pl[i])detect(i,true,pl[i]);
  for(const [name,discount]of [['discount',true]]){
   const state=current[name];if(!state)continue;const [,p2,p3,p4]=state.points;
   if(!state.reversed&&!state.entered&&bars[i].close<Math.min(p2.price,p4.price)){state.reversed=true;const base=Math.min(p2.price,p4.price),height=p3.price-base,target=base-height*factor(p.vip_discount_short_mode);signal(out,bars,i,'short',bars[i].close,null,target,'DISCOUNT FAILED - SHORT',{score:state.score,patternPoints:state.points});state.zone.endIndex=i;}
   // Original duplicate else-if makes the max-wait invalidation branch unreachable; do not repair it silently.
   if(!state.reversed&&!state.entered&&bars[i].close>p3.price){state.entered=true;const target=p3.price+(p3.price-p4.price)*factor(p.vip_discount_long_mode)*Math.max(state.score/100,.5);signal(out,bars,i,'long',bars[i].close,null,target,'DISCOUNT LONG Breakout',{score:state.score,patternPoints:state.points});state.zone.endIndex=i;}
   if(!state.reversed&&!state.entered)state.zone.endIndex=Math.min(i,state.start+state.maxWait);
  }
  if(p.vip_enable_premium&&ph[i])detect(i,false,ph[i]);
  const state=current.premium;if(state){const [,p2,p3,p4]=state.points;
   if(!state.reversed&&!state.entered&&bars[i].close>Math.max(p2.price,p4.price)){state.reversed=true;const base=Math.max(p2.price,p4.price),target=base+(base-p3.price)*factor(p.vip_premium_long_mode);signal(out,bars,i,'long',bars[i].close,null,target,'PREMIUM FAILED - LONG',{score:state.score,patternPoints:state.points});state.zone.endIndex=i;}
   if(!state.reversed&&!state.entered&&bars[i].close<p3.price){state.entered=true;const target=p3.price-(p4.price-p3.price)*factor(p.vip_premium_short_mode)*Math.max(state.score/100,.5);signal(out,bars,i,'short',bars[i].close,null,target,'PREMIUM SHORT Breakout',{score:state.score,patternPoints:state.points});state.zone.endIndex=i;}
   if(!state.reversed&&!state.entered)state.zone.endIndex=Math.min(i,state.start+state.maxWait);
  }
 }
 plot(out,'Pattern Quality',qualitySeries);out.notes.push('保留原四点结构、双向失败反转、质量权重和0.618/1/1.618目标；原指标不定义止损，stop留空。原到期分支条件与前一个if完全相同、不可达，故不擅自使其生效；长寿命结构不代表已验证有效。摆点可知时刻为右侧确认K。');
}
function trackLevels(out,bars,stopAtHit,fixedLength=null){
 const entries=out.signals.filter(s=>s.side==='long'||s.side==='short'),series=Array.from({length:5},()=>bars.map(()=>null));
 let active=null,entryCursor=0;out.levelEvents=[];
 for(let i=0;i<bars.length;i++){
  while(entryCursor<entries.length&&entries[entryCursor].index===i){const signal=entries[entryCursor++];active=finite(signal.stop)&&finite(signal.target)?{signal,targets:signal.targets?.length?signal.targets:[signal.target],done:[],open:true}:null;}
  if(!active||!active.open)continue;
  const s=active.signal,d=s.side==='long'?1:-1;
  if(!stopAtHit&&fixedLength!==null&&i>s.index+fixedLength)continue;
  series[0][i]=s.entry;series[1][i]=s.stop;
  active.targets.forEach((target,t)=>{if(!active.done[t])series[t+2][i]=target;});
  if(!stopAtHit||i<=s.index)continue;
  // Source policy: stop wins when a candle touches both stop and target; no entry-bar hits.
  if(d===1?bars[i].low<=s.stop:bars[i].high>=s.stop){out.levelEvents.push({index:i,time:bars[i].time,parentIndex:s.index,event:'stop',price:s.stop});active.open=false;continue;}
  active.targets.forEach((target,t)=>{if(!active.done[t]&&(d===1?bars[i].high>=target:bars[i].low<=target)){active.done[t]=true;out.levelEvents.push({index:i,time:bars[i].time,parentIndex:s.index,event:'target',targetNumber:t+1,price:target});}});
  if(active.done[active.targets.length-1])active.open=false;
 }
 for(let i=0;i<series.length;i++)if(series[i].some(finite))plot(out,i===0?'Active Entry':i===1?'Active Stop':'Active TP'+(i-1),series[i]);
 out.notes.push('Entry/SL/TP图线保留原末次信号替换和命中状态机；同根同时触及先计止损，信号K本身不计命中。这是OHLC研究图线状态，不是可成交或逐笔成交证明。');
}
const engines={
 'absorption-radar-pro':absorption,'apex-trend-signal-engine':apex,'edge-liquidity-engine':edge,'elite-advanced-pattern-scanner':scanner,'elite-flow-pro':eliteFlow,'equilibrium-confluence-engine':equilibrium,'liquidity-hunt-pro':liquidityHunt,'ma-confluence-engine':ribbon,'market-os':marketOS,'naive-bayes-order-flow':bayes,'pressure-flow-pro':pressure,
};
export function evaluateIndicator(id,bars,params={},context={}){
 const item=catalog.find(entry=>entry.id===id);if(!item)throw Error('未知Viprasol指标：'+id);
 const p=parameters(item.parameters,item.defaults,params),out={id,parameters:p,status:'ready',missingDependencies:[],signals:[],plots:[],zones:[],notes:[]};
 try{validateBars(bars);}catch(error){out.status='blocked';out.missingDependencies.push('valid_closed_ohlcv');out.notes.push(error.message);return out;}
 if(item.dependencies.includes('mintick')&&(!finite(context.mintick)||context.mintick<=0)){out.status='blocked';out.missingDependencies.push('official_mintick');out.notes.push('原公式依赖syminfo.mintick；未取得官方最小价格单位时停用，不猜测。');return out;}
 engines[id](bars,p,context,out);
 if(['absorption-radar-pro','pressure-flow-pro','liquidity-hunt-pro'].includes(id))trackLevels(out,bars,p.stopAtHit!==false,id==='pressure-flow-pro'?20:null);
 if(id==='edge-liquidity-engine'&&!out.plots.some(p=>p.values.some(finite))){out.status='blocked';out.missingDependencies.push('history_more_than_'+(p.winInput+2)+'_bars');}
 out.signals.sort((a,b)=>a.index-b.index);
 return out;
}
