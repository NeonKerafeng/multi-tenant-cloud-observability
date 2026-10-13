// Reusable UI components (buttons, tags, tables, dialogs, toasts, …).

import { ApiError } from './api.js';
import { h, icon, mount } from './dom.js';

// ---------------------------------------------------------------- buttons

/**
 * variant: primary | secondary | ghost | danger | danger-solid
 * onClick may be async: the button shows a busy state until it settles.
 */
export function button({
  label,
  icon: iconName,
  variant = 'secondary',
  size,
  onClick,
  disabled,
  title,
  type = 'button',
  href,
  target,
  id,
}) {
  const classes = ['btn', `btn-${variant}`, size && `btn-${size}`, !label && 'btn-icon'];
  const content = [iconName && icon(iconName, size === 'sm' ? 15 : 17), label && h('span', {}, label)];

  if (href) {
    return h(
      'a',
      {
        class: classes,
        href,
        target,
        rel: target ? 'noopener noreferrer' : undefined,
        title,
        'aria-label': label ? undefined : title,
        id,
      },
      content,
    );
  }

  const el = h(
    'button',
    { class: classes, type, disabled, title, 'aria-label': label ? undefined : title, id },
    content,
  );

  if (onClick) {
    el.addEventListener('click', async (event) => {
      if (el.classList.contains('busy')) {
        return;
      }

      const dialogs = document.querySelectorAll('.modal-backdrop').length;
      const result = onClick(event);

      // Busy while the action runs, but not while a dialog it opened is up.
      if (result instanceof Promise && document.querySelectorAll('.modal-backdrop').length === dialogs) {
        el.classList.add('busy');
        el.disabled = true;

        try {
          await result;
        } finally {
          el.classList.remove('busy');
          el.disabled = Boolean(disabled);
        }
      }
    });
  }

  return el;
}

// ---------------------------------------------------------------- tags

const TONES = {
  active: 'ok',
  enabled: 'ok',
  used: 'ok',
  healthy: 'ok',
  pending: 'info',
  provisioning: 'info',
  disabled: 'warn',
  degraded: 'warn',
  failing: 'danger',
  revoked: 'muted',
  expired: 'muted',
  deleted: 'muted',
  'platform-admin': 'brand',
  'tenant-admin': 'dark',
  viewer: 'neutral',
  Viewer: 'neutral',
  Editor: 'warn',
};

/** Slanted tag. tone: ok | info | warn | danger | muted | brand | dark | neutral */
export function tag(text, tone = TONES[text] ?? 'neutral') {
  return h('span', { class: `tag tag-${tone}` }, h('span', {}, text));
}

// ---------------------------------------------------------------- toasts

function toastHost() {
  return (
    document.getElementById('toasts') ??
    document.body.appendChild(h('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite' }))
  );
}

export function toast({ tone = 'ok', title, message, requestId, timeout }) {
  const el = h(
    'div',
    { class: `toast toast-${tone}`, role: tone === 'error' ? 'alert' : 'status' },
    h('div', { class: 'toast-icon' }, icon(tone === 'error' ? 'alert' : tone === 'info' ? 'info' : 'check', 18)),
    h(
      'div',
      { class: 'toast-body' },
      h('strong', {}, title),
      message && h('p', {}, message),
      requestId && h('p', { class: 'muted mono small' }, `request ${requestId}`),
    ),
    h('button', { class: 'toast-close', type: 'button', 'aria-label': 'Dismiss', onclick: () => el.remove() }, icon('x', 16)),
  );

  const host = toastHost();

  host.appendChild(el);

  while (host.childElementCount > 3) {
    host.firstElementChild.remove();
  }

  setTimeout(() => el.remove(), timeout ?? (tone === 'error' ? 10_000 : 5_000));

  return el;
}

export function toastError(error, title = 'Something went wrong') {
  if (error instanceof ApiError) {
    if (error.code === 'unauthenticated') {
      return null;
    }

    return toast({ tone: 'error', title, message: `${error.message} (${error.code})`, requestId: error.requestId });
  }

  return toast({ tone: 'error', title, message: String(error?.message ?? error) });
}

// ---------------------------------------------------------------- dialogs

/** Generic modal; returns { el, body, close }. */
export function modal({ title, subtitle, body, footer, size = 'md', onClose, dismissible = true, tone }) {
  const previous = document.activeElement;
  const titleId = `m-${Math.random().toString(36).slice(2)}`;

  let closed = false;

  const close = (value) => {
    if (closed) {
      return;
    }

    closed = true;
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    previous?.focus?.();
    onClose?.(value);
  };

  const onKey = (event) => {
    if (event.key === 'Escape' && dismissible && !panel.classList.contains('busy')) {
      close(undefined);
    }
  };

  const bodyEl = h('div', { class: 'modal-body' }, body);

  const panel = h(
    'div',
    { class: ['modal', `modal-${size}`, tone && `modal-${tone}`], role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h(
      'header',
      { class: 'modal-head' },
      h('div', {}, h('h2', { id: titleId }, title), subtitle && h('p', { class: 'muted' }, subtitle)),
      dismissible &&
        h('button', { class: 'modal-close', type: 'button', 'aria-label': 'Close', onclick: () => close(undefined) }, icon('x', 18)),
    ),
    bodyEl,
    footer && h('footer', { class: 'modal-foot' }, footer),
  );

  const backdrop = h(
    'div',
    {
      class: 'modal-backdrop',
      onmousedown: (event) => {
        if (event.target === backdrop && dismissible && !panel.classList.contains('busy')) {
          close(undefined);
        }
      },
    },
    panel,
  );

  document.addEventListener('keydown', onKey);
  document.body.appendChild(backdrop);

  requestAnimationFrame(() => {
    const first = panel.querySelector('input:not([type=hidden]):not([disabled]), select, textarea, .modal-foot .btn-primary, .modal-foot .btn-danger-solid');

    (first ?? panel.querySelector('.modal-close'))?.focus();
  });

  return { el: panel, body: bodyEl, close };
}

function errorBox(error) {
  return h(
    'div',
    { class: 'alert alert-error' },
    icon('alert', 18),
    h(
      'div',
      {},
      h('strong', {}, error instanceof ApiError ? error.code : 'Error'),
      h('p', {}, error.message),
      error.requestId && h('p', { class: 'muted mono small' }, `request ${error.requestId}`),
    ),
  );
}

/**
 * Confirmation that runs `action` inside the dialog (busy state, errors
 * shown inline). Resolves to the action's result, or null if cancelled.
 * typeToConfirm: the user must type this text to enable the button.
 */
export function confirmAction({ title, message, details, confirmLabel = 'Confirm', tone = 'danger', typeToConfirm, action }) {
  return new Promise((resolve) => {
    const errorSlot = h('div');
    const input =
      typeToConfirm &&
      h('input', {
        class: 'input mono',
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder: typeToConfirm,
        'aria-label': `Type ${typeToConfirm} to confirm`,
      });

    const confirm = button({
      label: confirmLabel,
      variant: tone === 'danger' ? 'danger-solid' : 'primary',
      disabled: Boolean(typeToConfirm),
      onClick: async () => {
        dialog.el.classList.add('busy');
        mount(errorSlot);

        try {
          const result = await action();

          dialog.close(result ?? true);
        } catch (error) {
          mount(errorSlot, errorBox(error));
        } finally {
          dialog.el.classList.remove('busy');
        }
      },
    });

    input?.addEventListener('input', () => {
      confirm.disabled = input.value.trim() !== typeToConfirm;
    });

    const dialog = modal({
      title,
      tone,
      size: 'sm',
      body: [
        h('p', {}, message),
        details && h('div', { class: 'confirm-details' }, details),
        typeToConfirm &&
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Type ', h('code', {}, typeToConfirm), ' to confirm'), input),
        errorSlot,
      ],
      footer: [button({ label: 'Cancel', variant: 'ghost', onClick: () => dialog.close(null) }), confirm],
      onClose: (value) => resolve(value ?? null),
    });
  });
}

/**
 * Form dialog. fields: [{ name, label, type, required, placeholder, hint,
 * options, value, min, max, minLength, maxLength, autocomplete, disabled,
 * generate, wide, mono, validate(value) -> message|'' }].
 * onSubmit(values) may throw an ApiError:
 * validation_failed details are shown under the matching fields.
 * Resolves to onSubmit's result, or null if cancelled.
 */
export function formDialog({ title, subtitle, intro, fields, submitLabel = 'Save', onSubmit, size = 'md' }) {
  return new Promise((resolve) => {
    const controls = {};
    const errors = {};
    const errorSlot = h('div');

    const rows = fields.map((field) => {
      const control = fieldControl(field);

      controls[field.name] = control;
      errors[field.name] = h('span', { class: 'field-error', role: 'alert' });

      return h(
        'label',
        { class: ['field', field.wide && 'field-wide'] },
        h('span', { class: 'field-label' }, field.label, field.required && h('span', { class: 'req' }, ' *')),
        control.wrapper ?? control,
        field.hint && h('span', { class: 'field-hint' }, field.hint),
        errors[field.name],
      );
    });

    const form = h(
      'form',
      { class: 'form-grid', novalidate: true, id: `f-${Math.random().toString(36).slice(2)}` },
      intro && h('div', { class: 'field-wide' }, intro),
      rows,
      errorSlot,
    );

    const submit = button({ label: submitLabel, variant: 'primary', type: 'submit' });

    submit.setAttribute('form', form.id);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();

      if (dialog.el.classList.contains('busy')) {
        return;
      }

      mount(errorSlot);
      Object.values(errors).forEach((e) => mount(e));

      let valid = true;

      for (const field of fields) {
        const input = controls[field.name].input ?? controls[field.name];

        input.setCustomValidity(field.validate?.(input.value) || '');

        if (!input.checkValidity()) {
          mount(errors[field.name], input.validationMessage);
          valid = false;
        }
      }

      if (!valid) {
        return;
      }

      const values = {};

      for (const field of fields) {
        const input = controls[field.name].input ?? controls[field.name];

        if (field.type === 'number') {
          values[field.name] = input.value === '' ? undefined : Number(input.value);
        } else {
          values[field.name] = input.value;
        }
      }

      dialog.el.classList.add('busy');
      submit.disabled = true;

      try {
        const result = await onSubmit(values);

        dialog.close(result ?? true);
      } catch (error) {
        const byField = error instanceof ApiError ? error.fieldErrors() : {};
        let shown = false;

        for (const [name, text] of Object.entries(byField)) {
          if (errors[name]) {
            mount(errors[name], text);
            shown = true;
          }
        }

        if (!shown) {
          mount(errorSlot, errorBox(error));
        }
      } finally {
        dialog.el.classList.remove('busy');
        submit.disabled = false;
      }
    });

    const dialog = modal({
      title,
      subtitle,
      size,
      body: form,
      footer: [button({ label: 'Cancel', variant: 'ghost', onClick: () => dialog.close(null) }), submit],
      onClose: (value) => resolve(value ?? null),
    });
  });
}

function fieldControl(field) {
  const common = {
    name: field.name,
    required: field.required,
    placeholder: field.placeholder,
    disabled: field.disabled,
    autocomplete: field.autocomplete ?? 'off',
    spellcheck: 'false',
  };

  if (field.type === 'select') {
    return h(
      'select',
      { class: 'input', ...common },
      field.options.map((o) => h('option', { value: o.value, selected: o.value === field.value }, o.label)),
    );
  }

  if (field.type === 'textarea') {
    return h('textarea', {
      class: 'input',
      rows: field.rows ?? 3,
      maxlength: field.maxLength,
      minlength: field.minLength,
      value: field.value ?? '',
      ...common,
    });
  }

  const input = h('input', {
    class: ['input', field.mono && 'mono'],
    type: field.type ?? 'text',
    value: field.value ?? '',
    min: field.min,
    max: field.max,
    step: field.type === 'number' ? 1 : undefined,
    pattern: field.pattern,
    minlength: field.minLength,
    maxlength: field.maxLength,
    ...common,
  });

  if (field.type !== 'password') {
    return input;
  }

  // Password: show/hide and (optionally) generate.
  const toggle = h('button', {
    class: 'input-addon',
    type: 'button',
    title: 'Show / hide',
    'aria-label': 'Show or hide password',
    onclick: () => {
      input.type = input.type === 'password' ? 'text' : 'password';
      mount(toggle, icon(input.type === 'password' ? 'eye' : 'eyeOff', 16));
    },
  }, icon('eye', 16));

  const generate =
    field.generate &&
    h('button', {
      class: 'input-addon',
      type: 'button',
      title: 'Generate a strong password',
      'aria-label': 'Generate a strong password',
      onclick: () => {
        input.value = strongPassword();
        input.type = 'text';
        mount(toggle, icon('eyeOff', 16));
        input.dispatchEvent(new Event('input'));
      },
    }, icon('wand', 16));

  const wrapper = h('div', { class: 'input-group' }, input, generate, toggle);

  return { wrapper, input };
}

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.!@#%';

export function strongPassword(length = 20) {
  const bytes = crypto.getRandomValues(new Uint32Array(length));

  return Array.from(bytes, (b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]).join('');
}

// ---------------------------------------------------------------- layout bits

export function pageHeader({ title, subtitle, crumbs = [], actions = [], meta = [] }) {
  return h(
    'header',
    { class: 'page-head' },
    crumbs.length > 0 &&
      h(
        'nav',
        { class: 'crumbs', 'aria-label': 'Breadcrumb' },
        crumbs.map((c, i) => [
          i > 0 && icon('chevronRight', 14),
          c.href ? h('a', { href: c.href }, c.label) : h('span', {}, c.label),
        ]),
      ),
    h(
      'div',
      { class: 'page-head-row' },
      h('div', { class: 'page-title' }, h('h1', {}, title), subtitle && h('p', { class: 'muted' }, subtitle)),
      actions.length > 0 && h('div', { class: 'page-actions' }, actions),
    ),
    meta.length > 0 && h('div', { class: 'page-meta' }, meta),
  );
}

export function metaItem(label, value) {
  return h('div', { class: 'meta-item' }, h('span', { class: 'meta-label' }, label), h('span', { class: 'meta-value' }, value));
}

export function card({ title, icon: iconName, actions = [], body, class: extra, flush }) {
  return h(
    'section',
    { class: ['card', flush && 'card-flush', extra] },
    title &&
      h(
        'header',
        { class: 'card-head' },
        h('h2', {}, iconName && icon(iconName, 18), title),
        actions.length > 0 && h('div', { class: 'card-actions' }, actions),
      ),
    h('div', { class: 'card-body' }, body),
  );
}

export function kpi({ label, value, icon: iconName = 'activity', tone = 'brand', hint, href }) {
  return h(
    href ? 'a' : 'div',
    { class: `kpi kpi-${tone}`, href },
    h('div', { class: 'kpi-icon' }, icon(iconName, 20)),
    h('div', { class: 'kpi-text' }, h('span', { class: 'kpi-label' }, label), h('strong', { class: 'kpi-value' }, value), hint && h('span', { class: 'kpi-hint' }, hint)),
  );
}

export function emptyState({ icon: iconName = 'info', title, text, action }) {
  return h(
    'div',
    { class: 'empty' },
    h('div', { class: 'empty-icon' }, icon(iconName, 28)),
    h('strong', {}, title),
    text && h('p', { class: 'muted' }, text),
    action,
  );
}

export function skeleton(lines = 4) {
  return h(
    'div',
    { class: 'skeleton', 'aria-busy': 'true', 'aria-label': 'Loading' },
    Array.from({ length: lines }, (_, i) => h('div', { class: 'skeleton-line', style: { width: `${92 - ((i * 17) % 40)}%` } })),
  );
}

export function tabs(items, active) {
  return h(
    'nav',
    { class: 'tabs', role: 'tablist' },
    items.map((item) =>
      h(
        'a',
        {
          class: ['tab', item.id === active && 'active'],
          href: item.href,
          role: 'tab',
          'aria-selected': item.id === active ? 'true' : 'false',
        },
        h('span', {}, item.icon && icon(item.icon, 16), item.label, item.count !== undefined && h('span', { class: 'tab-count' }, String(item.count))),
      ),
    ),
  );
}

export function copyButton(text, { label, title = 'Copy' } = {}) {
  const el = button({
    label,
    icon: 'copy',
    variant: 'ghost',
    size: 'sm',
    title,
    onClick: async () => {
      await copyText(text);
      el.classList.add('copied');
      toast({ tone: 'info', title: 'Copied to clipboard', timeout: 1800 });
      setTimeout(() => el.classList.remove('copied'), 1200);
    },
  });

  return el;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = h('textarea', { class: 'sr-only', readOnly: true, value: text });

    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

/** Monospace value with a copy button. */
export function copyable(text, { short } = {}) {
  return h('span', { class: 'copyable' }, h('code', { title: text }, short ?? text), copyButton(text));
}

export function codeBlock(text) {
  return h('div', { class: 'codeblock' }, h('pre', {}, h('code', {}, text)), h('div', { class: 'codeblock-copy' }, copyButton(text, { label: 'Copy' })));
}

// ---------------------------------------------------------------- async content

/**
 * Shows a skeleton, then render(data). On error: an error card with Retry.
 * Ignores results that arrive after the container left the page.
 * keep: leave the current content up while reloading (auto-refresh).
 */
export async function loadInto(container, load, render, { lines = 4, keep = false } = {}) {
  if (!keep || container.childElementCount === 0) {
    mount(container, skeleton(lines));
  }

  try {
    const data = await load();

    if (container.isConnected) {
      mount(container, render(data));
    }
  } catch (error) {
    if (!container.isConnected || (error instanceof ApiError && error.code === 'unauthenticated')) {
      return;
    }

    mount(
      container,
      h(
        'div',
        { class: 'load-error' },
        errorBox(error),
        button({ label: 'Retry', icon: 'sync', variant: 'secondary', onClick: () => loadInto(container, load, render, { lines }) }),
      ),
    );
  }
}

// ---------------------------------------------------------------- data table

/**
 * Client-side table with search, filters and sorting.
 * columns: [{ key, label, render(row), sort(row), class, width }]
 * filters: [{ id, label, value, options: [{ value, label, test(row) }] }]
 */
export function dataTable({ columns, rows, rowKey = (r) => r.id, search, searchPlaceholder = 'Search…', filters = [], empty, onRowClick, toolbar = [] }) {
  const state = {
    query: '',
    filters: Object.fromEntries(filters.map((f) => [f.id, f.value ?? f.options[0].value])),
    sortKey: null,
    sortDir: 1,
  };

  const tbody = h('tbody');
  const count = h('span', { class: 'table-count muted' });
  const headCells = columns.map((col) => {
    const th = h('th', { class: [col.class, col.sort && 'sortable'], style: col.width ? { width: col.width } : undefined, scope: 'col' }, col.label);

    if (col.sort) {
      th.tabIndex = 0;
      const toggle = () => {
        state.sortDir = state.sortKey === col.key ? -state.sortDir : 1;
        state.sortKey = col.key;
        headCells.forEach((cell) => cell.removeAttribute('aria-sort'));
        th.setAttribute('aria-sort', state.sortDir === 1 ? 'ascending' : 'descending');
        renderRows();
      };

      th.addEventListener('click', toggle);
      th.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle()));
    }

    return th;
  });

  function visibleRows() {
    const query = state.query.trim().toLowerCase();
    let result = rows.filter((row) => (query === '' || !search ? true : search(row).toLowerCase().includes(query)));

    for (const filter of filters) {
      const option = filter.options.find((o) => o.value === state.filters[filter.id]);

      if (option?.test) {
        result = result.filter(option.test);
      }
    }

    const col = columns.find((c) => c.key === state.sortKey);

    if (col?.sort) {
      result = [...result].sort((a, b) => {
        const x = col.sort(a);
        const y = col.sort(b);

        return (x < y ? -1 : x > y ? 1 : 0) * state.sortDir;
      });
    }

    return result;
  }

  function renderRows() {
    const visible = visibleRows();

    mount(count, `${visible.length} of ${rows.length}`);

    if (visible.length === 0) {
      mount(
        tbody,
        h('tr', { class: 'empty-row' }, h('td', { colspan: String(columns.length) }, rows.length === 0 ? empty : emptyState({ icon: 'search', title: 'No matches', text: 'Try another search or filter.' }))),
      );
      return;
    }

    mount(
      tbody,
      visible.map((row) => {
        const tr = h(
          'tr',
          { class: onRowClick && 'clickable', dataset: { key: String(rowKey(row)) } },
          columns.map((col) => h('td', { class: col.class, 'data-label': col.label }, col.render ? col.render(row) : String(row[col.key] ?? '—'))),
        );

        if (onRowClick) {
          tr.addEventListener('click', (event) => {
            if (!event.target.closest('button, a, input, select, label')) {
              onRowClick(row);
            }
          });
        }

        return tr;
      }),
    );
  }

  const searchInput =
    search &&
    h('input', {
      class: 'input',
      type: 'search',
      placeholder: searchPlaceholder,
      'aria-label': searchPlaceholder,
      oninput: (e) => {
        state.query = e.target.value;
        renderRows();
      },
    });

  const filterEls = filters.map((filter) =>
    h(
      'select',
      {
        class: 'input input-sm',
        'aria-label': filter.label,
        onchange: (e) => {
          state.filters[filter.id] = e.target.value;
          renderRows();
        },
      },
      filter.options.map((o) => h('option', { value: o.value, selected: o.value === state.filters[filter.id] }, o.label)),
    ),
  );

  renderRows();

  return h(
    'div',
    { class: 'table-wrap' },
    (searchInput || filterEls.length > 0 || toolbar.length > 0) &&
      h(
        'div',
        { class: 'table-toolbar' },
        searchInput && h('div', { class: 'search' }, icon('search', 16), searchInput),
        filterEls,
        h('div', { class: 'spacer' }),
        count,
        toolbar,
      ),
    h('div', { class: 'table-scroll' }, h('table', { class: 'table' }, h('thead', {}, h('tr', {}, headCells)), tbody)),
  );
}

/** Row action buttons (icon-only, with tooltips). */
export function rowActions(...buttons) {
  return h('div', { class: 'row-actions' }, buttons.filter(Boolean));
}

/** Key/value list for detail dialogs. */
export function detailList(pairs) {
  return h(
    'dl',
    { class: 'details' },
    pairs.filter(Boolean).map(([label, value]) => [h('dt', {}, label), h('dd', {}, value ?? h('span', { class: 'muted' }, '—'))]),
  );
}
