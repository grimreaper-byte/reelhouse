// Small form helpers for the settings screens.
import { h } from '../../dom.js';
import { api } from '../../api.js';
import { toast, toastError } from '../../components.js';

let uid = 0;
const nextId = () => `f${++uid}`;

/**
 * A labelled box. `secret`: something for another service (an API key, Tvheadend's password), shown as dots but not a
 * password box: a password manager fills those with this site's sign-in, whatever `autocomplete` says.
 */
export function textField(label, value, { type = 'text', hint, placeholder, autocomplete = 'off', min, max, mono, secret } = {}) {
  const id = nextId();
  const input = h(`input.input${secret ? '.secret' : ''}`, { id, type, value: value ?? '', placeholder, autocomplete, min, max, spellcheck: 'false', class: mono ? 'mono' : null });
  const el = h('div.field', h('label', { for: id }, label), input, hint && h('div.hint', hint));
  return {
    el,
    input,
    get value() {
      if (type === 'number') return Number(input.value);
      return type === 'password' || secret ? input.value : input.value.trim();
    },
  };
}

export function selectField(label, options, value, { hint, onChange } = {}) {
  const id = nextId();
  const input = h('select.select', { id, onChange: (e) => onChange?.(e.target.value) },
    options.map((o) => h('option', { value: o.value ?? o.id, selected: (o.value ?? o.id) === value, disabled: o.disabled }, o.label)));
  const el = h('div.field', h('label', { for: id }, label), input, hint && h('div.hint', hint));
  return { el, input, get value() { return input.value; } };
}

export function checkField(label, checked, { hint, onChange, disabled } = {}) {
  const input = h('input', { type: 'checkbox', checked: !!checked, disabled, onChange: (e) => onChange?.(e.target.checked) });
  const el = h('label.check', input, h('span', label, hint && h('small', hint)));
  return { el, input, get value() { return input.checked; } };
}

export function panel(title, desc, ...content) {
  return h('section.panel', h('h3', title), desc && h('p.desc', desc), ...content);
}

export function saveButton(label, collect, { after } = {}) {
  return h('button.btn.btn-primary', {
    onClick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const patch = collect();
        const res = await api.put('/api/settings', patch);
        toast(res.changed.length ? 'Saved' : 'No changes');
        await after?.(res);
      } catch (err) {
        toastError(err);
      } finally {
        btn.disabled = false;
      }
    },
  }, label);
}

export function actionButton(label, fn, { primary = false, danger = false, icon: iconEl } = {}) {
  return h(`button.btn${primary ? '.btn-primary' : ''}${danger ? '.btn-danger' : ''}`, {
    onClick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await fn(btn);
      } catch (err) {
        toastError(err);
      } finally {
        btn.disabled = false;
      }
    },
  }, iconEl, label);
}

export async function loadSettings(signal) {
  return api.get('/api/settings', { signal });
}
