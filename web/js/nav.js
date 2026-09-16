// Quick-access nav bar shared across the Film Room pages. Injects a slim
// sticky bar at the top of <body> with one-click links to every screen:
// the offline Viewer, Live, Review, and Settings. Highlights the current
// page via aria-current. Loaded once per page (no module system).
(function () {
  const PAGES = [
    { href: 'index.html', label: 'Viewer' },
    { href: 'live.html', label: 'Live' },
    { href: 'review.html', label: 'Review' },
    { href: 'settings.html', label: 'Settings' },
  ];

  // Resolve the current page filename (works for same-origin serving and
  // for file:// where the URL may be a bare path).
  let here = '';
  try {
    const p = location.pathname.replace(/\/$/, '');
    here = p.slice(p.lastIndexOf('/') + 1) || 'index.html';
  } catch { here = 'index.html'; }

  const nav = document.createElement('nav');
  nav.className = 'fr-nav';
  nav.setAttribute('aria-label', 'Film Room navigation');

  const brand = document.createElement('span');
  brand.className = 'fr-nav-brand';
  brand.textContent = 'Film Room';
  nav.appendChild(brand);

  const links = document.createElement('div');
  links.className = 'fr-nav-links';
  for (const p of PAGES) {
    const a = document.createElement('a');
    a.href = p.href;
    a.textContent = p.label;
    if (p.href === here) a.setAttribute('aria-current', 'page');
    links.appendChild(a);
  }
  nav.appendChild(links);

  const spacer = document.createElement('span');
  spacer.className = 'fr-nav-spacer';
  nav.appendChild(spacer);

  const hint = document.createElement('span');
  hint.className = 'fr-nav-hint';
  hint.textContent = 'offline viewer works without login';
  nav.appendChild(hint);

  // Inject the stylesheet if it isn't already on the page.
  if (!document.querySelector('link[href$="css/nav.css"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'css/nav.css';
    document.head.appendChild(link);
  }

  document.body.insertBefore(nav, document.body.firstChild);
})();
