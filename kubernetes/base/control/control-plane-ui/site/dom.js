// DOM + formatting helpers. The UI never uses innerHTML: every node is
// built here, so text from the API can never become markup.

const BOOLEAN_PROPS = new Set([
  'disabled',
  'checked',
  'selected',
  'hidden',
  'required',
  'readOnly',
  'multiple',
  'autofocus',
]);

const PROPERTY_PROPS = new Set(['value', 'textContent', 'htmlFor', 'tabIndex']);

function append(parent, child) {
  if (child === null || child === undefined || child === false || child === true) {
    return;
  }

  if (Array.isArray(child)) {
    child.forEach((c) => append(parent, c));
    return;
  }

  parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
}

/** h('button', { class: 'btn', onclick: fn }, 'Save') */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);

  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) {
      continue;
    }

    if (key === 'class') {
      el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
    } else if (key === 'style') {
      Object.assign(el.style, value);
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (BOOLEAN_PROPS.has(key) || PROPERTY_PROPS.has(key)) {
      el[key] = value;
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }

  append(el, children);

  return el;
}

/** Replaces the children of `el`. */
export function mount(el, ...children) {
  el.replaceChildren();
  append(el, children);

  return el;
}

// ---------------------------------------------------------------- icons
// Simple 24x24 stroke icons drawn for this UI.

const ICONS = {
  dashboard: ['M3 3h7v9H3z', 'M14 3h7v5h-7z', 'M14 12h7v9h-7z', 'M3 16h7v5H3z'],
  tenants: ['M4 21V5l8-3v19', 'M12 21V9l8 3v9', 'M2 21h20', 'M8 8h.01', 'M8 12h.01', 'M8 16h.01', 'M16 15h.01', 'M16 18h.01'],
  users: [
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2',
    'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    'M22 21v-2a4 4 0 0 0-3-3.87',
    'M16 3.13a4 4 0 0 1 0 7.75',
  ],
  agent: ['M3 4h18v6H3z', 'M3 14h18v6H3z', 'M7 7h.01', 'M7 17h.01', 'M11 7h6', 'M11 17h6'],
  key: ['M16 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M13.2 10.8 3 21', 'M7 17l2 2', 'M5 19l2 2'],
  shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'],
  sync: ['M3 12a9 9 0 0 1 15-6.7L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 0 1-15 6.7L3 16', 'M3 21v-5h5'],
  user: ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
  plus: ['M12 5v14', 'M5 12h14'],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6', 'M10 11v5', 'M14 11v5'],
  copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
  external: ['M14 3h7v7', 'M10 14 21 3', 'M21 14v7H3V3h7'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M21 21l-4.35-4.35'],
  check: ['M20 6 9 17l-5-5'],
  x: ['M18 6 6 18', 'M6 6l12 12'],
  sun: [
    'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
    'M12 1v2', 'M12 21v2', 'M4.2 4.2l1.4 1.4', 'M18.4 18.4l1.4 1.4',
    'M1 12h2', 'M21 12h2', 'M4.2 19.8l1.4-1.4', 'M18.4 5.6l1.4-1.4',
  ],
  moon: ['M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'],
  menu: ['M3 6h18', 'M3 12h18', 'M3 18h18'],
  power: ['M18.4 6.6a9 9 0 1 1-12.8 0', 'M12 2v10'],
  ban: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M4.9 4.9l14.2 14.2'],
  chart: ['M3 3v18h18', 'M7 15l4-4 3 3 5-6'],
  alert: ['M12 9v4', 'M12 17h.01', 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'],
  clock: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 6v6l4 2'],
  eye: ['M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  eyeOff: [
    'M3 3l18 18',
    'M10.6 10.6a3 3 0 0 0 4.2 4.2',
    'M9.9 4.2A10.9 10.9 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.2 3.2',
    'M6.6 6.6A18.4 18.4 0 0 0 1 12s4 8 11 8a10.8 10.8 0 0 0 5.4-1.4',
  ],
  wand: ['M15 4V2', 'M15 16v-2', 'M8 9h2', 'M20 9h2', 'M17.8 11.8 19 13', 'M17.8 6.2 19 5', 'M3 21l9-9', 'M12.2 6.2 11 5'],
  chevronRight: ['M9 18l6-6-6-6'],
  arrowLeft: ['M19 12H5', 'M12 19l-7-7 7-7'],
  info: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 16v-4', 'M12 8h.01'],
  lock: ['M5 11h14v10H5z', 'M8 11V7a4 4 0 0 1 8 0v4'],
  terminal: ['M4 17l6-6-6-6', 'M12 19h8'],
  activity: ['M22 12h-4l-3 9L9 3l-3 9H2'],
};

const SVG = 'http://www.w3.org/2000/svg';

export function icon(name, size = 18) {
  const svg = document.createElementNS(SVG, 'svg');

  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');

  for (const d of ICONS[name] ?? ICONS.info) {
    const path = document.createElementNS(SVG, 'path');

    path.setAttribute('d', d);
    svg.appendChild(path);
  }

  return svg;
}

/** The product mark: a chamfered red square with a signal trace. */
export function logo(size = 32) {
  const svg = document.createElementNS(SVG, 'svg');

  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('logo');

  const shape = document.createElementNS(SVG, 'polygon');

  shape.setAttribute('points', '7 0 32 0 32 25 25 32 0 32 0 7');
  shape.setAttribute('class', 'logo-shape');

  const trace = document.createElementNS(SVG, 'polyline');

  trace.setAttribute('points', '5 17 10 17 13 9 18 24 21 15 27 15');
  trace.setAttribute('fill', 'none');
  trace.setAttribute('stroke', '#fff');
  trace.setAttribute('stroke-width', '2.6');
  trace.setAttribute('stroke-linecap', 'round');
  trace.setAttribute('stroke-linejoin', 'round');

  svg.append(shape, trace);

  return svg;
}

// ---------------------------------------------------------------- format

const DATE_TIME = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

const STEPS = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1],
];

export function formatDate(value) {
  return value ? DATE_TIME.format(new Date(value)) : '—';
}

/** "3 minutes ago" / "in 2 hours". */
export function relative(value, now = Date.now()) {
  if (!value) {
    return '—';
  }

  const seconds = Math.round((new Date(value).getTime() - now) / 1000);

  for (const [unit, size] of STEPS) {
    if (Math.abs(seconds) >= size || unit === 'second') {
      return RELATIVE.format(Math.round(seconds / size), unit);
    }
  }

  return '—';
}

/** <time> with the relative text and the absolute date as tooltip. */
export function timeEl(value) {
  if (!value) {
    return h('span', { class: 'muted' }, '—');
  }

  return h('time', { datetime: value, title: formatDate(value) }, relative(value));
}

export function duration(seconds) {
  if (!seconds) {
    return '0 s';
  }

  if (seconds < 60) {
    return `${seconds} s`;
  }

  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  }

  return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
}

export function shortId(id) {
  return id ? id.slice(0, 8) : '—';
}

export function fullName(user) {
  return [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username;
}

export function initials(user) {
  const name = fullName(user);
  const parts = name.split(/[\s.-]+/).filter(Boolean);

  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}
