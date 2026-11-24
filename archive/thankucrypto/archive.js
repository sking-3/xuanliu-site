'use strict';
(() => {
  const get = id => document.getElementById(id);
  const sourceNames = {x:'X 原帖',weibo:'微博',interview:'深度访谈'};
  const size = 18;
  const params = new URLSearchParams(location.search);
  const state = {rows:[],query:params.get('q') || '',source:params.get('source') || 'all',category:params.get('category') || 'all',featured:params.get('featured') === '1',page:Math.max(1,Number(params.get('page')) || 1),loading:true,missing:[]};
  const reader = get('archive-reader');
  let returnFocus;
  const element = (tag,text,className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const normalized = text => String(text || '').toLocaleLowerCase('zh-CN');
  function normalize(row,source) {
    const text = source === 'interview' ? row.markdown || '' : row.text || '';
    const title = row.title || row.shortNote || row.topicTitle || text.split(/\n/)[0].slice(0,60) || '原始记录';
    return {id:source+'-'+row.id,source,date:row.date || '',category:row.domainName || row.category || (source === 'interview' ? '深度访谈' : '其他'),title,text,images:row.local_images || [],url:row.tweetUrl || row.sourceUrl || row.url || '',featured:source === 'interview' || ['S','A'].includes(row.qualityTier),search:normalized(title+' '+text)};
  }
  function syncUrl() {
    const url = new URL(location.href);
    const values = {q:state.query,source:state.source,category:state.category,featured:state.featured ? '1' : '',page:String(state.page)};
    for (const [key,value] of Object.entries(values)) {
      if (!value || value === 'all' || key === 'page' && value === '1') url.searchParams.delete(key);
      else url.searchParams.set(key,value);
    }
    history.replaceState(history.state,'',url);
  }
  function openReader(row,trigger) {
    returnFocus = trigger;
    get('archive-reader-title').textContent = row.title;
    get('archive-reader-meta').textContent = sourceNames[row.source]+' · '+row.date.slice(0,10)+' · '+row.category;
    const body = get('archive-reader-body');
    body.replaceChildren();
    for (const block of row.text.replace(/\r\n/g,'\n').split(/\n{2,}/)) {
      if (!block.trim() || /^!\[[^\]]*\]\([^)]+\)$/.test(block.trim())) continue;
      const heading = /^#{1,6}\s+/.test(block);
      const quote = /^>\s*/.test(block);
      const text = block.replace(/^#{1,6}\s+/,'').replace(/^>\s*/gm,'');
      body.append(element(heading ? 'h3' : quote ? 'blockquote' : 'p',text));
    }
    const photos = get('archive-reader-images');
    photos.replaceChildren();
    for (const path of row.images) {
      if (!/^images\/[a-zA-Z0-9_.-]+$/.test(path)) continue;
      const image = element('img');
      image.src = path;
      image.alt = row.title+'的原帖配图';
      image.loading = 'lazy';
      photos.append(image);
    }
    const original = get('archive-reader-original');
    let permitted = false;
    try { permitted = new URL(row.url).protocol === 'https:'; } catch { /* A missing original link does not prevent local reading. */ }
    original.hidden = !permitted;
    if (permitted) original.href = row.url;
    reader.showModal();
    reader.scrollTop = 0;
    get('archive-reader-close').focus();
  }
  function render() {
    const query = normalized(state.query.trim());
    const tokens = query.split(/\s+/).filter(Boolean);
    const rows = state.rows.filter(row => (state.source === 'all' || row.source === state.source) && (state.category === 'all' || row.category === state.category) && (!state.featured || row.featured) && tokens.every(token => row.search.includes(token)));
    const pages = Math.max(1,Math.ceil(rows.length/size));
    const page = Math.min(pages,Math.max(1,Math.floor(state.page)));
    if (!state.loading) state.page = page;
    const start = (page-1)*size;
    const list = get('archive-list');
    list.replaceChildren();
    for (const row of rows.slice(start,start+size)) {
      const entry = element('article',undefined,'archive-entry');
      const button = element('button',undefined,'archive-entry-button');
      button.type = 'button';
      const meta = element('div',undefined,'archive-entry-meta');
      meta.append(element('span',sourceNames[row.source]),element('time',row.date.slice(0,10)),element('span',row.category));
      button.append(meta,element('h2',row.title),element('p',row.text.replace(/\s+/g,' ').slice(0,170)+(row.text.length>170 ? '…' : '')));
      button.addEventListener('click',() => openReader(row,button));
      entry.append(button);
      list.append(entry);
    }
    if (!rows.length) list.append(element('p',state.loading ? '正在读取档案…' : state.rows.length ? '没有找到符合条件的内容，请尝试其他关键词。' : '暂时无法读取档案，请重试。','archive-empty'));
    get('archive-status').textContent = state.loading ? '正在读取档案…' : state.missing.length ? '部分资料暂时无法读取，可重试。' : '共 '+state.rows.length.toLocaleString('zh-CN')+' 篇，找到 '+rows.length.toLocaleString('zh-CN')+' 篇';
    get('archive-retry').hidden = !state.missing.length;
    get('archive-retry').disabled = state.loading;
    get('archive-count').textContent = rows.length ? (start+1)+'–'+Math.min(start+size,rows.length)+' / '+rows.length.toLocaleString('zh-CN') : '';
    get('archive-previous').disabled = page === 1 || state.loading;
    get('archive-next').disabled = page === pages || state.loading;
    syncUrl();
  }
  async function load() {
    state.loading = true;
    render();
    const sources = [['x','thankucrypto_tweets.json'],['weibo','thankucrypto_weibo.json'],['interview','thankucrypto_articles_full.json']];
    const results = await Promise.allSettled(sources.map(async ([source,file]) => {
      const response = await fetch('data/'+file,{credentials:'omit',signal:AbortSignal.timeout(12000)});
      if (!response.ok) throw Error('读取失败');
      const data = await response.json();
      if (!Array.isArray(data)) throw Error('资料格式待核验');
      return data.map(row => normalize(row,source));
    }));
    state.rows = [];
    state.missing = [];
    results.forEach((result,index) => {
      if (result.status === 'fulfilled') state.rows.push(...result.value);
      else state.missing.push(sources[index][0]);
    });
    state.rows.sort((a,b) => b.date.localeCompare(a.date));
    const categories = [...new Set(state.rows.map(row => row.category))].sort((a,b) => a.localeCompare(b,'zh-CN'));
    get('archive-category').replaceChildren(new Option('全部主题','all'),...categories.map(value => new Option(value,value)));
    if (!categories.includes(state.category)) state.category = 'all';
    if (!Object.hasOwn(sourceNames,state.source)) state.source = 'all';
    get('archive-category').value = state.category;
    get('archive-source').value = state.source;
    state.loading = false;
    render();
  }
  get('archive-search').value = state.query;
  get('archive-featured').checked = state.featured;
  get('archive-search').addEventListener('input',event => { state.query = event.target.value; state.page = 1; render(); });
  for (const key of ['source','category']) get('archive-'+key).addEventListener('change',event => { state[key] = event.target.value; state.page = 1; render(); });
  get('archive-featured').addEventListener('change',event => { state.featured = event.target.checked; state.page = 1; render(); });
  for (const [id,step] of [['archive-previous',-1],['archive-next',1]]) get(id).addEventListener('click',() => { state.page += step; render(); get('archive-list').scrollIntoView({block:'start'}); });
  get('archive-reader-close').addEventListener('click',() => reader.close());
  reader.addEventListener('close',() => returnFocus?.focus());
  get('archive-retry').addEventListener('click',load);
  load();
})();
