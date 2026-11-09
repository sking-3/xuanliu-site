/* Progressive enhancement only: no data requests, storage or research calculations. */
(() => {
  'use strict';
  const body = document.body;
  const sidebar = document.querySelector('.books-sidebar');
  const nav = sidebar && sidebar.querySelector('.books-nav');
  if (!body.classList.contains('books-shell') || !nav || sidebar.querySelector('.books-menu-toggle')) return;

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
      (nav.querySelector('[aria-current="page"]') || nav.querySelector('a')).focus();
    }
  };
  mobile.addEventListener('change', syncViewport);
  syncViewport();
  // Restore a consistent navigation state when returning through the browser cache.
  window.addEventListener('pageshow', syncViewport);

  // All existing skip links must move keyboard focus, not only the viewport.
  document.querySelectorAll('.skip, .skip-link').forEach((link) => {
    const href = link.getAttribute('href');
    if (!href || !href.startsWith('#')) return;
    const target = document.getElementById(href.slice(1));
    if (!target) return;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    link.addEventListener('click', () => target.focus({ preventScroll: true }));
  });
})();
