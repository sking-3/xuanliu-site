'use strict';
(() => {
  // Open linked evidence even when its parent details are collapsed.
  function reveal() {
    let target;
    try { target = document.getElementById(decodeURIComponent(location.hash.slice(1))); } catch { return; }
    if (!target) return;
    let ancestor = target.closest('details');
    while (ancestor) { ancestor.open = true; ancestor = ancestor.parentElement?.closest('details'); }
    requestAnimationFrame(() => { target.scrollIntoView({block:'start'}); if (target.matches('input,select,button')) target.focus({preventScroll:true}); });
  }
  window.addEventListener('hashchange',reveal);
  if (location.hash) reveal();
  const label = document.querySelector('[data-selection-batch]');
  if (!label) return;
  // The workspace owns the only request and the authoritative read state.
  const workspace=document.querySelector('[data-stock-workspace="'+label.dataset.selectionBatch+'"]');
  if (!workspace) {label.textContent='批次状态暂不可用';label.dataset.state='unavailable';return;}
  const sync=()=>{
    const state=workspace.dataset.publishedState || 'loading';
    label.dataset.state=state;
    label.textContent=(workspace.dataset.publishedLabel || '正在核对发布状态…')+
      (workspace.dataset.publishedAsOf ? ' · '+workspace.dataset.publishedAsOf : '');
  };
  const observer=new MutationObserver(sync);
  observer.observe(workspace,{attributes:true,attributeFilter:['data-published-state','data-published-label','data-published-as-of']});
  sync();
  window.addEventListener('pagehide',()=>observer.disconnect(),{once:true});
})();
