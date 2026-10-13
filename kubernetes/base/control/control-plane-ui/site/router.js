// Hash router: #/tenants/alpha/users. Hash routes keep the OIDC
// redirect_uri a single URL (the site root) and need no server rewrites.

const routes = [];
let cleanups = [];

/** pattern: '/tenants/:tenantKey/:tab?' */
export function route(pattern, handler) {
  const parts = pattern.split('/').filter(Boolean);

  routes.push({ parts, handler });
}

export function currentPath() {
  return location.hash.replace(/^#/, '') || '/';
}

export function navigate(path) {
  if (currentPath() === path) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    location.hash = path;
  }
}

export function href(path) {
  return `#${path}`;
}

/** Runs when the user leaves the current page (timers, listeners). */
export function onLeave(fn) {
  cleanups.push(fn);
}

function matchRoute(path) {
  const segments = path.split('/').filter(Boolean).map(decodeURIComponent);

  for (const { parts, handler } of routes) {
    const params = {};
    let ok = segments.length <= parts.length;

    for (let i = 0; ok && i < parts.length; i += 1) {
      const part = parts[i];
      const optional = part.endsWith('?');
      const name = part.replace(/^:|\?$/g, '');

      if (i >= segments.length) {
        ok = optional;
      } else if (part.startsWith(':')) {
        params[name] = segments[i];
      } else {
        ok = part === segments[i];
      }
    }

    if (ok) {
      return { handler, params };
    }
  }

  return null;
}

export function startRouter(render) {
  const run = () => {
    cleanups.forEach((fn) => fn());
    cleanups = [];
    render(matchRoute(currentPath()), currentPath());
  };

  window.addEventListener('hashchange', run);
  run();
}
