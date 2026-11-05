import { h } from '../dom.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { afterSignIn } from '../app.js';
import { withReveal } from '../components.js';

function brand() {
  return h('div.brand', h('img.brand-mark', { src: '/favicon.svg', alt: '' }), 'Reelhouse');
}

function form({ fields, submitLabel, onSubmit }) {
  const error = h('div.form-error', { hidden: true });
  const button = h('button.btn.btn-primary.btn-lg', { type: 'submit' }, submitLabel);
  const inputs = {};
  const el = h('form', {
    onSubmit: async (e) => {
      e.preventDefault();
      error.hidden = true;
      button.disabled = true;
      try {
        await onSubmit(Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value])));
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        button.disabled = false;
      }
    },
  },
  fields.map((f) => {
    inputs[f.name] = h('input.input', { name: f.name, type: f.type || 'text', autocomplete: f.autocomplete, required: true, minlength: f.minlength, value: f.value || '' });
    // A new password (reveal: true) gets the show/hide button; signing in doesn't.
    const box = f.reveal ? withReveal(inputs[f.name]).el : inputs[f.name];
    return h('div.field', h('label', { for: f.name }, f.label), box, f.hint && h('div.hint', f.hint));
  }),
  error,
  button);
  for (const [k, i] of Object.entries(inputs)) i.id = k;
  return el;
}

export async function loginView(ctx) {
  // Only same-site paths ("/x"), never "//host" or "/\host" which browsers treat as other sites.
  const next = /^\/(?![/\\])/.test(ctx.query.next || '') ? ctx.query.next : '/';
  return h('div.auth-page',
    h('div.auth-card',
      brand(),
      h('p.lead', state.server?.name ? `Sign in to ${state.server.name}` : 'Sign in'),
      form({
        fields: [
          { name: 'username', label: 'Username', autocomplete: 'username' },
          { name: 'password', label: 'Password', type: 'password', autocomplete: 'current-password' },
        ],
        submitLabel: 'Sign in',
        onSubmit: async ({ username, password }) => {
          await api.post('/api/auth/login', { username, password });
          await afterSignIn(next === '/login' ? '/' : next);
        },
      }),
    ),
  );
}

export async function setupView() {
  return h('div.auth-page',
    h('div.auth-card',
      brand(),
      h('p.lead', 'Welcome! Create the admin account for this server.'),
      form({
        fields: [
          { name: 'username', label: 'Username', autocomplete: 'username' },
          { name: 'password', label: 'Password', type: 'password', autocomplete: 'new-password', reveal: true, minlength: 8, hint: 'At least 8 characters. Use a strong one if you plan to allow access from outside your home.' },
          { name: 'confirm', label: 'Confirm password', type: 'password', autocomplete: 'new-password', reveal: true },
        ],
        submitLabel: 'Create account',
        onSubmit: async ({ username, password, confirm }) => {
          if (password !== confirm) throw new Error('The passwords do not match');
          await api.post('/api/setup', { username, password });
          await afterSignIn('/settings/libraries?welcome=1');
        },
      }),
    ),
  );
}
