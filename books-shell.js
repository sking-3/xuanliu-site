/* Progressive enhancement only: no data requests, storage or research calculations. */
(() => {
  'use strict';
  const root = document.documentElement;
  root.classList.add('books-shell-preparing');
  const init = () => {
  try {
  const body = document.body;
  const loader = document.createElement?.('div');
  if (loader && body?.appendChild && !document.getElementById?.('books-load-screen')) {
    loader.id = 'books-load-screen';
    loader.className = 'books-load-screen';
    loader.setAttribute('aria-hidden', 'true');
    body.appendChild(loader);
    const dismiss = () => { loader.classList.add('is-done'); window.setTimeout(() => loader.remove(), 360); };
    window.addEventListener('load', dismiss, {once:true});
    window.setTimeout(dismiss, 760);
  }
  const sidebar = document.querySelector('.books-sidebar');
  const nav = sidebar && sidebar.querySelector('.books-nav');
  if (!body?.classList.contains('books-shell') || !nav || sidebar.querySelector('.books-menu-toggle')) return;

  // Decorative local SVGs retain the original destinations and accessible names.
  const navigation = {
    '市场总览': { label: '市场总览', key: 'market', path: 'M4 19V5M4 19h16M7 14l4-4 4 3 5-7' },
    'A股选股': { label: 'A股选股', key: 'a-shares', path: 'M6 3v4m0 7v7M3.5 7h5v7h-5zM17 3v7m0 7v4M14.5 10h5v7h-5z' },
    '美股选股': { label: '美股选股', key: 'us', path: 'M4 19h16M6 16V9m6 7V4m6 12v-6M4 6l4-3' },
    '带单员广场': { label: '带单广场', key: 'traders', path: 'M15 20v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M9 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M17 4a3 3 0 0 1 0 6m1 4a4 4 0 0 1 3 4v2' },
    '公司研究': { label: '公司研究', key: 'companies', path: 'M5 21V4h10v17M15 10h4v11M3 21h18M8 8h4M8 12h4M8 16h4' },
    '历史研究': { label: '历史研究', key: 'history', path: 'M3 11a9 9 0 1 1 2.5 7M3 4v7h7M12 7v5l3 2' },
    '交易员研习': { label: '交易员研习', key: 'library', path: 'M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4zM13 7a3 3 0 0 1 3-3h5v15h-5a3 3 0 0 0-3 2' },
    '研究工具': { label: '研究工具', key: 'tools', path: 'M4 6h16M4 18h16M8 3v6m8 6v6M4 12h16M15 9v6' },
  };
  nav.querySelectorAll('a').forEach((link) => {
    const name = link.textContent.trim();
    const item = navigation[name];
    if (!item || link.querySelector('.books-nav-icon')) return;
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'books-nav-icon');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '1.7');
    icon.setAttribute('stroke-linecap', 'round');
    icon.setAttribute('stroke-linejoin', 'round');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', item.path);
    icon.appendChild(path);
    const label = document.createElement('span');
    label.className = 'books-nav-label';
    label.textContent = item.label;
    link.setAttribute('aria-label', name);
    link.setAttribute('title', name);
    link.setAttribute('data-books-nav', item.key);
    link.replaceChildren(icon, label);
  });

  const mobile = window.matchMedia('(max-width: 760px)');
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'books-menu-toggle';
  toggle.textContent = '导航菜单';
  if (!nav.id) nav.id = 'books-primary-navigation';
  const panel = document.createElement('div');
  panel.id = 'books-menu-panel';
  panel.className = 'books-menu-panel';
  toggle.setAttribute('aria-controls', panel.id);
  toggle.setAttribute('aria-expanded', 'false');
  sidebar.insertBefore(toggle, nav);
  sidebar.insertBefore(panel, nav);
  panel.appendChild(nav);
  const shortcuts = sidebar.querySelector('.books-shortcuts');
  if (shortcuts) panel.appendChild(shortcuts);
  nav.hidden = false;
  body.classList.add('books-shell-enhanced');

  const menuIsOpen = () => toggle.getAttribute('aria-expanded') === 'true';
  const setOpen = (open, restoreFocus = false) => {
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? '收起导航' : '导航菜单';
    panel.hidden = mobile.matches && !open;
    panel.inert = panel.hidden;
    if (restoreFocus) toggle.focus();
    showNavigation();
    scheduleHide();
  };
  const navigationState = {hidden:null, pointer:false};
  const recall = document.createElement('button');
  recall.type = 'button';
  recall.className = 'books-nav-recall';
  recall.textContent = '导航';
  recall.setAttribute('aria-label', '显示导航');
  if (!sidebar.id) sidebar.id = 'books-navigation-shell';
  recall.setAttribute('aria-controls', sidebar.id);
  body.appendChild(recall);
  let hideTimer = null;
  let lastScrollY = window.scrollY;
  let revealBottom = 0;

  function renderNavigation(hidden) {
    if (navigationState.hidden === hidden) return;
    navigationState.hidden = hidden;
    sidebar.setAttribute('data-nav-hidden', String(hidden));
    recall.hidden = !hidden;
  }
  function cancelHide() {
    window.clearTimeout(hideTimer);
    hideTimer = null;
  }
  function showNavigation() {
    cancelHide();
    renderNavigation(false);
  }
  function updateRevealBoundary() {
    revealBottom = Number.parseFloat(getComputedStyle(sidebar).top) + sidebar.offsetHeight + 12;
  }
  function canHide() {
    return !document.hidden && (window.innerWidth >= 1100 || mobile.matches) && window.scrollY > 160;
  }
  function isPinned() {
    return navigationState.pointer || menuIsOpen()
      || sidebar.contains(document.activeElement) && document.activeElement.matches(':focus-visible');
  }
  function scheduleHide() {
    if (!canHide() || isPinned()) {
      showNavigation();
      return;
    }
    if (hideTimer !== null || navigationState.hidden) return;
    hideTimer = window.setTimeout(() => {
      hideTimer = null;
      if (canHide() && !isPinned()) renderNavigation(true);
    }, 2400);
  }
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    if (y < lastScrollY || !canHide()) showNavigation();
    lastScrollY = y;
    scheduleHide();
  }, {passive:true});
  window.addEventListener('pointermove', (event) => {
    if (mobile.matches || event.pointerType === 'touch') return;
    const inside = event.clientY >= 0 && event.clientY <= revealBottom;
    if (inside === navigationState.pointer) return;
    navigationState.pointer = inside;
    if (inside) showNavigation();
    else scheduleHide();
  }, {passive:true});
  document.addEventListener('pointerleave', () => {
    navigationState.pointer = false;
    scheduleHide();
  });
  sidebar.addEventListener('focusin', () => {
    showNavigation();
    scheduleHide();
  });
  sidebar.addEventListener('focusout', () => window.setTimeout(scheduleHide, 0));
  window.addEventListener('resize', () => {
    navigationState.pointer = false;
    updateRevealBoundary();
    showNavigation();
    scheduleHide();
  });
  document.addEventListener('visibilitychange', () => {
    navigationState.pointer = false;
    showNavigation();
    scheduleHide();
  });
  recall.addEventListener('click', () => {
    showNavigation();
    if (mobile.matches) setOpen(true, true);
    else scheduleHide();
  });
  toggle.addEventListener('click', () => setOpen(!menuIsOpen()));
  document.addEventListener('click', (event) => {
    if (mobile.matches && menuIsOpen() && !sidebar.contains(event.target) && !recall.contains(event.target)) {
      setOpen(false, sidebar.contains(document.activeElement));
    }
  });
  panel.addEventListener('click', (event) => {
    if (mobile.matches && event.target.closest?.('a')) setOpen(false, true);
  });
  sidebar.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && mobile.matches && menuIsOpen()) {
      event.preventDefault();
      setOpen(false, true);
    }
  });
  const syncViewport = () => {
    const focusInPanel = panel.contains(document.activeElement);
    setOpen(false, mobile.matches && focusInPanel);
    // A hidden mobile toggle must not retain keyboard focus on desktop.
    if (!mobile.matches && document.activeElement === toggle) {
      (nav.querySelector('[aria-current]') || nav.querySelector('a')).focus();
    }
  };
  mobile.addEventListener('change', syncViewport);
  syncViewport();
  updateRevealBoundary();
  if (typeof ResizeObserver === 'function') {
    const navigationResize = new ResizeObserver(updateRevealBoundary);
    navigationResize.observe(sidebar);
    const ticker = document.getElementById('index-ticker');
    if (ticker) navigationResize.observe(ticker);
  }
  // Restore a consistent navigation state when returning through the browser cache.
  window.addEventListener('pageshow', event => {
    if (event.persisted) { syncViewport(); updateRevealBoundary(); }
  });

  // All existing skip links must move keyboard focus, not only the viewport.
  document.querySelectorAll('.skip, .skip-link').forEach((link) => {
    const href = link.getAttribute('href');
    if (!href || !href.startsWith('#')) return;
    const target = document.getElementById(href.slice(1));
    if (!target) return;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    link.addEventListener('click', () => target.focus({ preventScroll: true }));
  });
  } finally {
    root.classList.remove('books-shell-preparing');
  }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once:true});
  else init();
})();
