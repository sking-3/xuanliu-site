'use strict';

/* Industry chain names, segments and A-share constituents adapted from
 * https://github.com/theBigGavin/marketingdashboard/blob/2d71054d76bb78b82ddb7818af4bdff49a6179a7/src/config/dashboard.ts
 * MIT License
 * 
 * Copyright (c) 2026 gavinsunquestor
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

(function (root) {
  const summaries = typeof module === 'object' && module.exports
    ? require('../home-daily-movers.js') : root.BooksDailyMovers;

  const chains = [
    {name:"大模型", segments:[
      {name:"上游 · 算力基座", codes:["688041.SH","688256.SH","300308.SZ","601138.SH","000977.SZ"]},
      {name:"中游 · 模型与平台", codes:["002230.SZ","601360.SH","300418.SZ","688111.SH","300229.SZ"]},
      {name:"下游 · Agent与应用", codes:["300624.SZ","300496.SZ","688088.SH","688327.SH","002362.SZ"]}
    ]},
    {name:"具身智能", segments:[
      {name:"上游 · 核心零部件", codes:["688017.SH","002472.SZ","603728.SH","603662.SH","300580.SZ"]},
      {name:"中游 · 整机与执行器", codes:["002747.SZ","300124.SZ","002050.SZ","601689.SH","300660.SZ"]},
      {name:"下游 · 大脑与场景", codes:["300024.SZ","603666.SH","689009.SH","688169.SH","603486.SH"]}
    ]},
    {name:"半导体", segments:[
      {name:"上游 · 设备与材料", codes:["002371.SZ","688012.SH","688126.SH","002409.SZ","688037.SH"]},
      {name:"中游 · 制造与封测", codes:["688981.SH","688347.SH","600584.SH","002156.SZ","688249.SH"]},
      {name:"下游 · 设计与应用", codes:["603501.SH","300782.SZ","603986.SH","688256.SH","688008.SH"]}
    ]},
    {name:"新能源", segments:[
      {name:"上游 · 资源与材料", codes:["002466.SZ","002460.SZ","603799.SH","600438.SH","601012.SH"]},
      {name:"中游 · 电池与电力设备", codes:["300750.SZ","002594.SZ","300014.SZ","300274.SZ","002202.SZ"]},
      {name:"下游 · 运营与整车", codes:["000625.SZ","601127.SH","300001.SZ","600905.SH","600406.SH"]}
    ]},
    {name:"创新药", segments:[
      {name:"上游 · CXO与原料", codes:["603259.SH","300347.SZ","002821.SZ","603127.SH","300759.SZ"]},
      {name:"中游 · 创新药企", codes:["600276.SH","688235.SH","002422.SZ","688266.SH"]},
      {name:"下游 · 商业化与流通", codes:["300122.SZ","601607.SH","000028.SZ","603939.SH","600998.SH"]}
    ]},
    {name:"新型工业化", segments:[
      {name:"上游 · 工业软件与控制", codes:["688777.SH","600845.SH","600588.SH","603859.SH","300687.SZ"]},
      {name:"中游 · 智能制造装备", codes:["300124.SZ","002747.SZ","300450.SZ","300724.SZ","002595.SZ"]},
      {name:"下游 · 数字化与互联", codes:["601138.SH","300166.SZ","300378.SZ","688568.SH","002230.SZ"]}
    ]},
    {name:"数字政府", segments:[
      {name:"上游 · 云网与安全", codes:["002368.SZ","300454.SZ","002439.SZ","600536.SH","603019.SH"]},
      {name:"中游 · 平台与数据", codes:["000938.SZ","300075.SZ","300525.SZ","603636.SH","300212.SZ"]},
      {name:"下游 · 智慧场景", codes:["002415.SZ","002236.SZ","300188.SZ","600728.SH","002152.SZ"]}
    ]},
    {name:"智慧医疗", segments:[
      {name:"上游 · 医疗信息化", codes:["300253.SZ","300451.SZ","600718.SH","300168.SZ","300078.SZ"]},
      {name:"中游 · AI医疗与设备", codes:["688271.SH","300760.SZ","603882.SH","300244.SZ","300676.SZ"]},
      {name:"下游 · 互联网与健康管理", codes:["002603.SZ","002044.SZ","002223.SZ","300146.SZ","600998.SH"]}
    ]}
  ].map(chain => ({
    ...chain, codes: [...new Set(chain.segments.flatMap(segment => segment.codes))]
  }));
  const members = new Map(chains.map(chain => [chain.name, new Set(chain.codes)]));
  const dayInShanghai = new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai'});

  function build(snapshot) {
    const {asOf} = summaries.summarize(snapshot);
    const rows = [];
    const groups = new Map();
    for (const stock of snapshot.stocks) {
      if (!Number.isFinite(stock.price) || stock.price <= 0 || !Number.isFinite(stock.changePct)) continue;
      const sector = typeof stock.boardName === 'string' ? stock.boardName.trim() : '';
      const cap = stock.totalMarketCap;
      const name = stock.name.trim().replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1');
      rows.push({
        code:stock.code, name, sector:sector || '未分类', exchange:stock.exchange,
        price:stock.price, changePct:stock.changePct, totalMarketCap:Number.isFinite(cap) && cap >= 0 ? cap : null
      });
      if (!sector || sector === '未分类') continue;
      let group = groups.get(sector);
      if (!group) {
        group = {name:sector,count:0,up:0,down:0,flat:0,sum:0};
        groups.set(sector, group);
      }
      group.count++;
      group.sum += stock.changePct;
      if (stock.changePct > 0) group.up++;
      else if (stock.changePct < 0) group.down++;
      else group.flat++;
    }
    const sectors = [...groups.values()].map(({sum,...group}) => ({
      ...group, meanChange:sum / group.count
    })).sort((a,b) => b.meanChange - a.meanChange || a.name.localeCompare(b.name,'zh-CN'));
    return {day:dayInShanghai.format(new Date(asOf)),rows,sectors};
  }

  // Code/name prefilter only. It cannot attest current listing, suspension or 10% limits.
  function mainBoard(row) {
    return /^(?:600|601|603|605)\d{3}\.SH$/.test(row.code) || /^(?:000|001|002|003)\d{3}\.SZ$/.test(row.code);
  }
  function riskName(row) { return /^(?:S?\*?ST)|退/i.test(row.name.replace(/\s/g,'')); }

  function select(rows, options = {}) {
    const {sector,venue,chain,minChange,maxChange,minCap,maxCap,onlySaved,saved} = options;
    const query = (options.query || '').trim().toUpperCase();
    const selectedChain = members.get(chain);
    return rows.filter(row => {
      if (options.universe === 'main' && !mainBoard(row)) return false;
      if (options.excludeRiskNames && riskName(row)) return false;
      if (sector && row.sector !== sector || venue && row.exchange !== venue) return false;
      if (chain && !selectedChain?.has(row.code) || onlySaved && !saved?.has(row.code)) return false;
      if (query && !row.name.toUpperCase().includes(query) && !row.code.includes(query)) return false;
      if (Number.isFinite(minChange) && row.changePct < minChange || Number.isFinite(maxChange) && row.changePct > maxChange) return false;
      if (Number.isFinite(minCap) || Number.isFinite(maxCap)) {
        if (!Number.isFinite(row.totalMarketCap)) return false;
        const capInYi = row.totalMarketCap / 1e8;
        if (Number.isFinite(minCap) && capInYi < minCap || Number.isFinite(maxCap) && capInYi > maxCap) return false;
      }
      return true;
    }).sort((a,b) => b.changePct - a.changePct || a.code.localeCompare(b.code));
  }

  const api = {build,select,chains,mainBoard,riskName};
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BooksMarketPool = api;
})(globalThis);
