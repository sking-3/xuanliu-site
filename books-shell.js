/* Progressive enhancement only: no data requests, storage or research calculations. */
(() => {
  'use strict';
  const root = document.documentElement;
  root.classList.add('books-shell-preparing');
  const init = () => {
  try {
  const body = document.body;
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
  toggle.setAttribute('aria-controls', nav.id);
  toggle.setAttribute('aria-expanded', 'false');
  sidebar.insertBefore(toggle, nav);
  body.classList.add('books-shell-enhanced');

  const setOpen = (open, restoreFocus = false) => {
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? '收起导航' : '导航菜单';
    nav.hidden = mobile.matches && !open;
    if (restoreFocus) toggle.focus();
  };
  toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
  sidebar.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && mobile.matches && toggle.getAttribute('aria-expanded') === 'true') {
      event.preventDefault();
      setOpen(false, true);
    }
  });
  const syncViewport = () => {
    const focusInNav = nav.contains(document.activeElement);
    setOpen(false, mobile.matches && focusInNav);
    // A hidden mobile toggle must not retain keyboard focus on desktop.
    if (!mobile.matches && document.activeElement === toggle) {
      (nav.querySelector('[aria-current]') || nav.querySelector('a')).focus();
    }
  };
  mobile.addEventListener('change', syncViewport);
  syncViewport();
  // Restore a consistent navigation state when returning through the browser cache.
  window.addEventListener('pageshow', event => { if (event.persisted) syncViewport(); });

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
