import { h, icon, timeAgo } from '../../dom.js';
import { api } from '../../api.js';
import { modal, toast, toastError, confirmDialog, withReveal } from '../../components.js';
import { render } from '../../router.js';
import { state } from '../../state.js';
import { pairingDialog } from './pairing.js';
import { avatarContent } from '../../avatar.js';

export async function usersTab(ctx) {
  const [{ users }, { libraries }] = await Promise.all([
    api.get('/api/users', { signal: ctx.signal }),
    api.get('/api/libraries', { signal: ctx.signal }),
  ]);
  const libName = (id) => libraries.find((l) => l.id === id)?.name;
  return h('div',
    h('h2', 'Users'),
    h('p.lead', 'Everyone gets their own watch history and “Continue Watching”. No accounts with any outside service are involved.'),
    h('section.panel',
      h('div.list', users.map((u) => h('div.list-row',
        h('div.avatar', { style: { cursor: 'default' } }, avatarContent(u)),
        h('div.grow',
          h('div.title', u.username, u.id === state.me.user.id ? ' (you)' : '', u.isAdmin ? h('span.status.ok', { style: { marginLeft: '8px' } }, 'Admin') : null),
          h('div.sub', u.isAdmin || !u.libraryAccess
            ? 'All libraries'
            : `Libraries: ${u.libraryAccess.map(libName).filter(Boolean).join(', ') || 'none'}`),
          h('div.sub', `Created ${timeAgo(u.createdAt)} · ${u.sessions} signed-in device${u.sessions === 1 ? '' : 's'}`
            + (u.streamLimit ? ` · plays on ${u.streamLimit === 1 ? '1 device' : `${u.streamLimit} devices`} at a time` : '')),
        ),
        h('button.btn.btn-icon', {
          'aria-label': `Pair the Reelhouse app for ${u.username}`,
          title: 'Pair the Reelhouse app (QR code or link)',
          onClick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
              await pairingDialog({ user: u, onPaired: () => render() });
            } catch (err) {
              toastError(err);
            } finally {
              btn.disabled = false;
            }
          },
        }, icon('link', 18)),
        h('button.btn.btn-icon', { 'aria-label': `Edit ${u.username}`, onClick: () => userEditor(u, libraries) }, icon('edit', 18)),
        u.id !== state.me.user.id && h('button.btn.btn-icon.btn-danger', {
          'aria-label': `Delete ${u.username}`,
          onClick: async () => {
            if (!(await confirmDialog({ title: `Delete ${u.username}?`, message: 'Their account and watch history will be removed.', confirmLabel: 'Delete user', danger: true }))) return;
            try {
              await api.del(`/api/users/${u.id}`);
              render();
            } catch (err) {
              toastError(err);
            }
          },
        }, icon('trash', 18)),
      ))),
      h('div.panel-actions', { style: { marginTop: '16px' } },
        h('button.btn.btn-primary', { onClick: () => userEditor(null, libraries) }, icon('plus', 18), 'Add user')),
    ),
  );
}

const STREAM_LIMITS = [null, 1, 2, 3, 4, 5, 6, 8, 10];
const DEFAULT_STREAM_LIMIT = 2; // as the server's, for a new user

function userEditor(user, libraries) {
  const username = h('input.input', { id: 'u-name', value: user?.username || '', autocomplete: 'off' });
  const password = h('input.input', { id: 'u-pass', type: 'password', autocomplete: 'new-password', placeholder: user ? 'Leave empty to keep the current password' : '' });
  const isAdminBox = h('input', { type: 'checkbox', checked: !!user?.isAdmin });
  const allLibs = h('input', { type: 'checkbox', checked: !user?.libraryAccess });
  const libBoxes = libraries.map((l) => ({
    id: l.id,
    box: h('input', { type: 'checkbox', checked: !user?.libraryAccess || user.libraryAccess.includes(l.id) }),
    name: l.name,
  }));
  const libList = h('div', { style: { paddingLeft: '26px' } }, libBoxes.map((l) => h('label.check', l.box, h('span', l.name))));
  // How many devices they may play on at once: an admin's choice, enforced when playback starts.
  // Their current limit is always among the choices, so saving never changes it unasked.
  const current = user ? user.streamLimit ?? null : DEFAULT_STREAM_LIMIT;
  const choices = [...new Set([...STREAM_LIMITS, current])].sort((a, b) => (a ?? 0) - (b ?? 0));
  const streams = h('select.select', { id: 'u-streams' },
    choices.map((n) => h('option', { value: n ?? '', selected: current === n }, n == null ? 'No limit' : `${n} at a time`)));
  // Live TV (Settings → Live TV): watching it, scheduling recordings, and series recordings. Admins always can.
  const liveTvBox = h('input', { type: 'checkbox', checked: user ? user.liveTv : true });
  const recordBox = h('input', { type: 'checkbox', checked: user ? user.liveTvRecord : false });
  const seriesBox = h('input', { type: 'checkbox', checked: user ? user.liveTvSeries : false });
  const sync = () => {
    const disabled = allLibs.checked || isAdminBox.checked;
    libList.style.opacity = disabled ? '0.5' : '1';
    for (const l of libBoxes) l.box.disabled = disabled;
    liveTvBox.disabled = isAdminBox.checked;
    recordBox.disabled = isAdminBox.checked || !liveTvBox.checked;
    if (isAdminBox.checked) {
      liveTvBox.checked = true;
      recordBox.checked = true;
      seriesBox.checked = true;
    } else if (!liveTvBox.checked) {
      recordBox.checked = false;
    }
    if (!recordBox.checked) seriesBox.checked = false;
    seriesBox.disabled = isAdminBox.checked || !recordBox.checked;
  };
  liveTvBox.addEventListener('change', sync);
  recordBox.addEventListener('change', sync);
  allLibs.addEventListener('change', sync);
  isAdminBox.addEventListener('change', sync);
  sync();

  modal({
    title: user ? `Edit ${user.username}` : 'Add user',
    body: h('div',
      h('div.field', h('label', { for: 'u-name' }, 'Username'), username),
      h('div.field', h('label', { for: 'u-pass' }, 'Password'), withReveal(password).el, h('div.hint', 'At least 8 characters.')),
      h('label.check', isAdminBox, h('span', 'Administrator', h('small', 'Can change settings, manage users and libraries.'))),
      h('div.field-label', { style: { margin: '16px 0 8px' } }, 'Library access'),
      h('label.check', allLibs, h('span', 'All libraries (including ones added later)')),
      libList,
      h('div.field', { style: { marginTop: '16px' } },
        h('label', { for: 'u-streams' }, 'Devices playing at once'),
        streams,
        h('div.hint', `How many devices this person can play on at the same time (the web app, the Reelhouse app and Kodi alike; ${DEFAULT_STREAM_LIMIT} unless you choose otherwise). Downloads watched on a phone don’t count.`)),
      h('div.field-label', { style: { margin: '16px 0 8px' } }, 'Live TV'),
      h('label.check', liveTvBox, h('span', 'Can watch live TV', h('small', 'The TV guide and live channels, when Live TV is turned on (Settings → Live TV).'))),
      h('label.check', recordBox, h('span', 'Can schedule recordings', h('small', 'Record from the guide, and see, cancel or delete their own recordings on the Manage Recordings page. Admins can always do both, and change anyone’s.'))),
      h('label.check', seriesBox, h('span', 'Can set series recordings', h('small', 'Record every episode of a show on a channel from the guide, and cancel their own series recordings. Needs “Can schedule recordings”.'))),
      user && h('div', { style: { marginTop: '12px' } }, h('button.btn.btn-sm', {
        type: 'button',
        onClick: async () => {
          try {
            await api.post(`/api/users/${user.id}/signout`);
            toast(`${user.username} was signed out everywhere`);
          } catch (err) {
            toastError(err);
          }
        },
      }, icon('signOut', 16), 'Sign out all devices')),
    ),
    actions: [
      { label: 'Cancel' },
      {
        label: user ? 'Save' : 'Create user',
        primary: true,
        onClick: async () => {
          const body = {
            username: username.value.trim(),
            isAdmin: isAdminBox.checked,
            libraryAccess: allLibs.checked ? null : libBoxes.filter((l) => l.box.checked).map((l) => l.id),
            streamLimit: streams.value ? Number(streams.value) : null,
            liveTv: liveTvBox.checked,
            liveTvRecord: recordBox.checked,
            liveTvSeries: seriesBox.checked,
          };
          if (password.value) body.password = password.value;
          if (user) await api.patch(`/api/users/${user.id}`, body);
          else await api.post('/api/users', body);
          toast(user ? 'User saved' : 'User created');
          render();
        },
      },
    ],
  });
}
