(() => {
  const sidebar = document.querySelector('body > .layout-container > .sidebar, body > .layout > .sidebar');
  const toggle = document.getElementById('academy-toc-toggle');
  const mobile = window.matchMedia('(max-width: 1100px)');
  const state = {tocOpen: false, aiOpen: false, activeSection: null};
  const aiButton = document.querySelector('.ai-fab');
  if (aiButton) aiButton.setAttribute('aria-label', aiButton.textContent.trim().replace(/\s+/g, ' '));
  const aiDialog = document.createElement('dialog');
  aiDialog.id = 'academy-ai-notice';
  aiDialog.setAttribute('aria-labelledby', 'academy-ai-title');
  aiDialog.innerHTML = '<h2 id="academy-ai-title">AI 问答尚未配置</h2><p>原站的 AI 服务仅向原站开放。本站已保存完整阅读资料，目录、全文检索和配图可以正常使用。</p><form method="dialog"><button>继续阅读</button></form>';
  document.body.appendChild(aiDialog);
  function renderAI() {
    if (state.aiOpen && !aiDialog.open) aiDialog.showModal();
    if (!state.aiOpen && aiDialog.open) aiDialog.close();
  }
  aiDialog.addEventListener('close', () => {state.aiOpen = aiDialog.open;});
  if (typeof window.toggleAiDrawer === 'function') window.toggleAiDrawer(false);
  window.toggleAiDrawer = open => {state.aiOpen = open === false ? false : !aiDialog.open; renderAI();};
  const showAINotice = () => {state.aiOpen = true; renderAI();};
  window.sendAiQuestion = showAINotice;
  window.sendAiMessage = showAINotice;

  if (!sidebar) {
    toggle.hidden = true;
    return;
  }
  const marker = document.createComment('Original chapter directory position');
  sidebar.before(marker);
  const dialog = document.createElement('dialog');
  dialog.id = 'academy-toc-dialog';
  dialog.setAttribute('aria-label', '章节目录');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'academy-toc-close';
  close.textContent = '完成';
  dialog.appendChild(close);
  document.body.appendChild(dialog);
  function renderTOC() {
    const wasOpen = dialog.open;
    if (mobile.matches) {
      if (sidebar.parentElement !== dialog) dialog.appendChild(sidebar);
    } else {
      state.tocOpen = false;
      if (marker.nextSibling !== sidebar) marker.after(sidebar);
    }
    if (state.tocOpen && !wasOpen) dialog.showModal();
    if (!state.tocOpen && wasOpen) dialog.close();
    toggle.setAttribute('aria-expanded', String(state.tocOpen));
    revealCurrent();
  }
  function closeTOC() {state.tocOpen = false; renderTOC();}
  toggle.addEventListener('click', () => {state.tocOpen = !state.tocOpen; renderTOC();});
  close.addEventListener('click', closeTOC);
  dialog.addEventListener('close', () => {state.tocOpen = dialog.open; toggle.setAttribute('aria-expanded', String(state.tocOpen));});
  dialog.addEventListener('click', event => {
    if (event.target === dialog || event.target.closest('a[href^="#"], [data-tid]')) closeTOC();
  });
  sidebar.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.target.id === 'sidebarSearchInput') {
      event.preventDefault();
      closeTOC();
    }
  });
  if (sidebar.classList.contains('academy-book-toc')) {
    sidebar.addEventListener('click', event => {
      const mode = event.target.closest('.mode-btn');
      if (!mode) return;
      closeTOC();
      const reader = document.getElementById(mode.id === 'btnPdfMode' ? 'pdfReader' : 'webReader');
      reader.scrollIntoView({behavior: 'instant', block: 'start'});
    });
    document.getElementById('backTop').addEventListener('click', event => {
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      window.scrollTo({top: 0, behavior: 'instant'});
    }, {capture: true});
  }
  const main = document.querySelector('main');
  const entries = Array.from(sidebar.querySelectorAll('a[href^="#"]')).map(link => ({
    link, target: document.getElementById(decodeURIComponent(link.getAttribute('href').slice(1)))
  })).filter(entry => entry.target && main.contains(entry.target));
  sidebar.setAttribute('data-academy-spy', '');
  let sections = [];
  let readingTop = 0;
  let pageHeight = 0;
  let layoutDirty = true;
  let frame = 0;

  function revealCurrent() {
    if (!state.activeSection || mobile.matches && !state.tocOpen) return;
    let link = state.activeSection.link;
    const group = link.closest('.toc-group');
    if (group && group.classList.contains('collapsed')) link = group.querySelector('.toc-vol-btn');
    if (!link.getClientRects().length) return;
    // Scroll the directory's own viewport; never move the article to reveal a link.
    for (let container = link.parentElement; container && container !== document.body; container = container.parentElement) {
      if (container.scrollHeight <= container.clientHeight || !/auto|scroll/.test(getComputedStyle(container).overflowY)) continue;
      const bounds = container.getBoundingClientRect();
      const item = link.getBoundingClientRect();
      let top = 0;
      if (item.top < bounds.top + 8) top = item.top - bounds.top - 8;
      else if (item.bottom > bounds.bottom - 8) top = item.bottom - bounds.bottom + 8;
      if (top) container.scrollBy({top, behavior: 'instant'});
      break;
    }
  }

  function renderActive(section) {
    if (state.activeSection === section) return;
    if (state.activeSection) {
      state.activeSection.link.removeAttribute('aria-current');
      const group = state.activeSection.link.closest('.toc-group');
      if (group) group.removeAttribute('data-academy-current');
    }
    state.activeSection = section;
    let title = '';
    if (section) {
      section.link.setAttribute('aria-current', 'location');
      const group = section.link.closest('.toc-group');
      if (group) group.setAttribute('data-academy-current', '');
      title = (section.link.querySelector('.toc-title-txt') || section.link).textContent.trim().replace(/\s+/g, ' ');
    }
    toggle.textContent = title ? '目录 · ' + title : '章节目录';
    toggle.setAttribute('aria-label', title ? '章节目录，当前章节：' + title : '章节目录');
    toggle.title = title || '章节目录';
    revealCurrent();
  }

  function updateSection() {
    frame = 0;
    if (layoutDirty) {
      layoutDirty = false;
      readingTop = (parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0) + 8;
      sections = entries.filter(entry => entry.target.getClientRects().length);
      for (const entry of sections) entry.top = entry.target.getBoundingClientRect().top + window.scrollY;
      sections.sort((a, b) => a.top - b.top);
      pageHeight = document.documentElement.scrollHeight;
    }
    let current = null;
    for (const section of sections) {
      if (section.top > window.scrollY + readingTop + 1) break;
      current = section;
    }
    if (window.scrollY > 0 && window.scrollY + window.innerHeight >= pageHeight - 2) current = sections[sections.length - 1] || null;
    renderActive(current);
  }
  function scheduleSection() {
    if (!frame) frame = requestAnimationFrame(updateSection);
  }
  function invalidateSections() {
    layoutDirty = true;
    scheduleSection();
  }
  window.addEventListener('scroll', scheduleSection, {passive: true});
  window.addEventListener('resize', invalidateSections);
  window.addEventListener('pageshow', invalidateSections);
  new ResizeObserver(invalidateSections).observe(main);
  new MutationObserver(invalidateSections).observe(main, {subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open']});
  invalidateSections();

  mobile.addEventListener('change', renderTOC);
  renderTOC();
})();
