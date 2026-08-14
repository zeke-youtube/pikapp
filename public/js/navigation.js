const routes = new Set(['home', 'explore', 'ai', 'profile']);

export function destination(view, options = {}, base = location.href) {
  const url = new URL(base);
  url.search = '';
  url.hash = '';
  if (view === 'post' && options.id) url.searchParams.set('post', options.id);
  else if (routes.has(view) && view !== 'home') url.hash = `#${view}${options.username ? `/${encodeURIComponent(options.username)}` : ''}`;
  return `${url.pathname}${url.search}${url.hash}`;
}

export function navigate(view, options = {}, { replace = false } = {}) {
  history[replace ? 'replaceState' : 'pushState']({ view }, '', destination(view, options));
  dispatchEvent(new PopStateEvent('popstate'));
}

export function navigateTarget(target) {
  const [view, value] = String(target || 'home').split('/');
  navigate(view === 'post' ? 'home' : view, view === 'profile' && value ? { username: decodeURIComponent(value) } : {});
}
