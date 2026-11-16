'use strict';

(() => {
  const reader = window.BooksBinancePublicRecords.reader(window);
  const select = document.getElementById('evidence-symbol');
  const rows = document.getElementById('evidence-rows');
  const status = document.getElementById('evidence-status');
  const empty = document.getElementById('evidence-empty');
  const refresh = document.getElementById('evidence-refresh');
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  let snapshot = reader.last();
  let note = '已保存记录';
  function draw() {
    const all = snapshot?.allRows || [];
    const selection = select.value;
    select.replaceChildren(new Option('全部合约', ''));
    for (const symbol of [...new Set(all.map(row => row.symbol))].sort()) select.add(new Option(symbol, symbol));
    if ([...select.options].some(option => option.value === selection)) select.value = selection;
    const matching = all.filter(row => !select.value || row.symbol === select.value);
    rows.replaceChildren();
    for (const row of matching.slice(0, 20)) {
      const tr = document.createElement('tr');
      tr.dataset.id = row.id;
      const when = document.createElement('time');
      when.dateTime = new Date(row.updatedAt).toISOString();
      when.textContent = formatter.format(row.updatedAt);
      tr.insertCell().append(when);
      const security = tr.insertCell();
      const symbol = document.createElement('strong');
      symbol.textContent = row.symbol;
      const direction = document.createElement('small');
      direction.textContent = row.direction;
      security.append(symbol, direction);
      tr.insertCell().textContent = row.quantity + ' ' + row.baseAsset;
      tr.insertCell().textContent = row.price + ' ' + row.quoteAsset;
      rows.append(tr);
    }
    const checked = snapshot?.checkedAt ? ' · 核验于 ' + formatter.format(new Date(snapshot.checkedAt)) : '';
    status.textContent = [note, matching.length + ' 条匹配'].join(' · ') + checked;
    empty.hidden = matching.length !== 0;
    empty.textContent = all.length ? '这个合约没有匹配记录。' : '暂无可读取的公开成交记录，可核对币安原页。';
  }
  async function read() {
    refresh.disabled = true;
    try {
      snapshot = await reader.read();
      note = snapshot.stopped ? '来源已停止更新，显示已保存记录' : '公开记录';
    } catch {
      note = '本次未能刷新，显示已保存记录';
    } finally {
      draw();
      refresh.disabled = false;
    }
  }
  select.addEventListener('change', draw);
  refresh.addEventListener('click', read);
  draw();
  read();
})();
