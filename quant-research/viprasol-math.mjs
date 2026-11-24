/* Array-based, closed-bar arithmetic used by the native Viprasol ports. */
const finite = Number.isFinite;
export const field = (bars, key) => bars.map(bar => bar[key]);
export function validateBars(bars) {
  if (!Array.isArray(bars) || !bars.length) throw Error('缺少真实OHLCV数据');
  let previous = -Infinity;
  for (const bar of bars) {
    if (!['time','open','high','low','close','volume'].every(key => finite(bar[key])) || bar.time <= previous || bar.low > Math.min(bar.open,bar.close) || bar.high < Math.max(bar.open,bar.close) || bar.low > bar.high || bar.volume < 0) throw Error('OHLCV格式或时间顺序无效');
    previous = bar.time;
  }
}
export function parameters(definitions, defaults, input = {}) {
  const result = {...defaults, ...input};
  for (const key of Object.keys(input)) if (!(key in defaults)) throw Error('未知参数：' + key);
  for (const item of definitions) {
    const value = result[item.key];
    if (item.type === 'boolean') {if (typeof value !== 'boolean') throw Error('无效参数：' + item.key);}
    else if (item.type === 'select' || item.type === 'string') {if (typeof value !== 'string' || item.options && !item.options.includes(value)) throw Error('无效参数：' + item.key);}
    else if (item.type !== 'goals' && (!finite(value) || item.integer && !Number.isInteger(value) || item.min !== undefined && value < item.min || item.max !== undefined && value > item.max)) throw Error('无效参数：' + item.key);
  }
  return result;
}
export function rolling(values, length, operation) {
  return values.map((_, i) => {
    if (i < length - 1) return null;
    const window = values.slice(i - length + 1, i + 1);
    return window.every(finite) ? operation(window) : null;
  });
}
export const sum = (values, length) => rolling(values,length,window => window.reduce((a,b) => a+b,0));
export const sma = (values, length) => rolling(values,length,window => window.reduce((a,b) => a+b,0)/length);
export const highest = (values, length) => values.map((_,i)=>{const window=values.slice(Math.max(0,i-length+1),i+1).filter(finite);return window.length?Math.max(...window):null;});
export const lowest = (values, length) => values.map((_,i)=>{const window=values.slice(Math.max(0,i-length+1),i+1).filter(finite);return window.length?Math.min(...window):null;});
export function ema(values, length) {
  let state = null; const alpha = 2/(length+1);
  return values.map(value => {
    if (!finite(value)) return null;
    state = state === null ? value : alpha*value+(1-alpha)*state;
    return state;
  });
}
export function rma(values, length) {
  let state = null, seed = [];
  return values.map(value => {
    if (!finite(value)) return null;
    if (state === null) {seed.push(value); if (seed.length < length) return null; state=seed.reduce((a,b)=>a+b,0)/length;}
    else state = (value+(length-1)*state)/length;
    return state;
  });
}
export const wma = (values, length) => rolling(values,length,window => window.reduce((total,value,i)=>total+value*(i+1),0)/(length*(length+1)/2));
export function stdev(values, length, biased = true) {
  return rolling(values,length,window=>{const mean=window.reduce((a,b)=>a+b,0)/length;return Math.sqrt(window.reduce((total,value)=>total+(value-mean)**2,0)/(biased?length:length-1));});
}
export const variance = (values,length,biased=true) => stdev(values,length,biased).map(value=>finite(value)?value*value:null);
export function atr(bars, length = 14) {
  return rma(bars.map((bar,i)=>i===0?bar.high-bar.low:Math.max(bar.high-bar.low,Math.abs(bar.high-bars[i-1].close),Math.abs(bar.low-bars[i-1].close))),length);
}
export function rsi(values, length = 14) {
  const up=rma(values.map((value,i)=>i&&finite(value)&&finite(values[i-1])?Math.max(value-values[i-1],0):null),length);
  const down=rma(values.map((value,i)=>i&&finite(value)&&finite(values[i-1])?Math.max(values[i-1]-value,0):null),length);
  return up.map((value,i)=>!finite(value)||!finite(down[i])?null:down[i]===0?100:value===0?0:100-100/(1+value/down[i]));
}
export function adx(bars, length = 14, smoothing = length) {
  const tr=rma(bars.map((bar,i)=>i?Math.max(bar.high-bar.low,Math.abs(bar.high-bars[i-1].close),Math.abs(bar.low-bars[i-1].close)):null),length);
  const plus=rma(bars.map((bar,i)=>{if(!i)return null;const up=bar.high-bars[i-1].high,down=bars[i-1].low-bar.low;return up>down&&up>0?up:0;}),length);
  const minus=rma(bars.map((bar,i)=>{if(!i)return null;const up=bar.high-bars[i-1].high,down=bars[i-1].low-bar.low;return down>up&&down>0?down:0;}),length);
  const plusDI=plus.map((v,i)=>finite(v)&&finite(tr[i])?tr[i]===0?0:100*v/tr[i]:null);
  const minusDI=minus.map((v,i)=>finite(v)&&finite(tr[i])?tr[i]===0?0:100*v/tr[i]:null);
  const strength=rma(plusDI.map((v,i)=>finite(v)&&finite(minusDI[i])?100*Math.abs(v-minusDI[i])/((v+minusDI[i])||1):null),smoothing);
  return {adx:strength,plusDI,minusDI};
}
export function pivots(values, left = 3, right = left, kind = 'high') {
  return values.map((_,i)=>{
    const index=i-right;if(index<left)return null;
    const value=values[index],window=values.slice(index-left,i+1);
    if(!window.every(finite))return null;
    for(let j=index-left;j<=i;j++)if(j!==index&&(kind==='high'?(j<index?values[j]>value:values[j]>=value):(j<index?values[j]<value:values[j]<=value)))return null;
    return {value,index};
  });
}
export const crossOver = (a,b,i) => i>0&&finite(a[i])&&finite(a[i-1])&&finite(typeof b==='number'?b:b[i])&&finite(typeof b==='number'?b:b[i-1])&&a[i]>(typeof b==='number'?b:b[i])&&a[i-1]<=(typeof b==='number'?b:b[i-1]);
export const crossUnder = (a,b,i) => i>0&&finite(a[i])&&finite(a[i-1])&&finite(typeof b==='number'?b:b[i])&&finite(typeof b==='number'?b:b[i-1])&&a[i]<(typeof b==='number'?b:b[i])&&a[i-1]>=(typeof b==='number'?b:b[i-1]);
export function linreg(values, length, offset = 0) {
  return rolling(values,length,window=>{const mean=window.reduce((a,b)=>a+b,0)/length,x=(length-1)/2;let covariance=0,variance=0;for(let i=0;i<length;i++){covariance+=(i-x)*(window[i]-mean);variance+=(i-x)**2;}const slope=variance?covariance/variance:0;return mean+slope*(length-1-offset-x);});
}
export function supertrend(bars, factor = 3, length = 10) {
  const range=atr(bars,length),upper=[],lower=[],direction=[],line=[];
  for(let i=0;i<bars.length;i++){
    if(!finite(range[i])){upper.push(null);lower.push(null);direction.push(null);line.push(null);continue;}
    const mid=(bars[i].high+bars[i].low)/2,rawUpper=mid+factor*range[i],rawLower=mid-factor*range[i];
    upper[i]=!finite(upper[i-1])||rawUpper<upper[i-1]||bars[i-1].close>upper[i-1]?rawUpper:upper[i-1];
    lower[i]=!finite(lower[i-1])||rawLower>lower[i-1]||bars[i-1].close<lower[i-1]?rawLower:lower[i-1];
    direction[i]=!finite(range[i-1])?1:line[i-1]===upper[i-1]?(bars[i].close>upper[i]?-1:1):(bars[i].close<lower[i]?1:-1);
    line[i]=direction[i]===-1?lower[i]:upper[i];
  }
  return {line,direction,upper,lower};
}
export function vwap(bars, anchor = bar => Math.floor(bar.time/86400000)) {
  let key,weighted=0,volume=0;
  return bars.map(bar=>{const next=anchor(bar);if(next!==key){key=next;weighted=0;volume=0;}weighted+=(bar.high+bar.low+bar.close)/3*bar.volume;volume+=bar.volume;return volume?weighted/volume:null;});
}
export function rising(values, length) {return values.map((value,i)=>i<length||!finite(value)||!values.slice(i-length,i).every(finite)?false:value>Math.max(...values.slice(i-length,i)));}
export function falling(values, length) {return values.map((value,i)=>i<length||!finite(value)||!values.slice(i-length,i).every(finite)?false:value<Math.min(...values.slice(i-length,i)));}
