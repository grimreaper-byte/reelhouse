import { h, icon, timeAgo, formatBytes } from '../../dom.js';
import { api } from '../../api.js';
import { state } from '../../state.js';
import { toast, toastError, confirmDialog, withReveal, modal } from '../../components.js';
import { render } from '../../router.js';
import { AVATAR_TYPES, prepareAvatar, avatarContent } from '../../avatar.js';
import { panel, textField, actionButton, checkField } from './form.js';
import { pairingDialog } from './pairing.js';

export async function accountTab(ctx) {
  const user = state.me.user;
  const { devices } = await api.get('/api/me/devices', { signal: ctx?.signal });
  const current = textField('Current password', '', { type: 'password', autocomplete: 'current-password' });
  const next = textField('New password', '', { type: 'password', autocomplete: 'new-password', hint: 'At least 8 characters.' });
  const confirm = textField('Confirm new password', '', { type: 'password', autocomplete: 'new-password' });
  // Each can be shown while it's typed, the current one too; all are hidden again once the password is changed.
  const reveals = [withReveal(current.input), withReveal(next.input), withReveal(confirm.input)];
  return h('div',
    h('h2', 'Your account'),
    h('p.lead', `Signed in as ${user.username}${user.isAdmin ? ' (admin)' : ''}.`),
    picturePanel(user),
    devicesPanel(devices),
    sharingPanel(user),
    panel('Change password', 'Changing your password signs you out on all other devices, apps included.',
      current.el, next.el, confirm.el,
      h('div.panel-actions', actionButton('Change password', async () => {
        if (next.value !== confirm.value) throw new Error('The new passwords do not match');
        await api.post('/api/me/password', { current: current.input.value, next: next.input.value });
        current.input.value = '';
        next.input.value = '';
        confirm.input.value = '';
        reveals.forEach((r) => r.conceal());
        toast('Password changed');
      }, { primary: true })),
    ),
    panel('Sign out', 'Sign out of Reelhouse on this device.',
      h('div.panel-actions', actionButton('Sign out', async () => {
        await api.post('/api/auth/logout');
        location.href = '/login';
      }, { danger: true })),
    ),
  );
}

// Your picture: a chosen file is checked and shown as it will look before anything is uploaded.
function picturePanel(user) {
  const changed = (r) => {
    state.me.user = r.user;
    window.dispatchEvent(new Event('reelhouse:user')); // the top bar
    render();
  };
  const input = h('input', {
    type: 'file',
    accept: AVATAR_TYPES.join(','),
    hidden: true,
    onChange: async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      let prepared;
      try {
        prepared = await prepareAvatar(file);
      } catch (err) {
        toastError(err);
        return;
      }
      modal({
        title: 'Use this picture?',
        body: h('div', { style: { textAlign: 'center' } },
          h('div.avatar.avatar-xl', h('img', { src: prepared.url, alt: 'Your new picture' })),
          h('p.hint', `${file.name} · ${prepared.width}×${prepared.height} · ${formatBytes(file.size)}`),
          h('p.hint', 'The middle of the picture, cut square. Reelhouse checks it again when it arrives and keeps a small copy without the photo’s details (such as where it was taken).')),
        actions: [
          { label: 'Cancel' },
          { label: 'Choose another', onClick: () => { input.click(); } },
          {
            label: 'Use this picture',
            primary: true,
            onClick: async () => {
              changed(await api.upload('/api/me/avatar', prepared.blob, { type: 'image/jpeg' }));
              toast('Your picture is updated');
            },
          },
        ],
        onClose: () => URL.revokeObjectURL(prepared.url),
      });
    },
  });
  return panel('Your picture', 'Shown in the top bar, in the Reelhouse app and in the Users list. JPEG, PNG, WebP or GIF, up to 15 MB.',
    h('div.avatar-row',
      h('div.avatar.avatar-lg', avatarContent(user)),
      h('div.panel-actions',
        actionButton(user.avatar ? 'Choose another…' : 'Choose a picture…', () => input.click(), { icon: icon('image', 16) }),
        user.avatar && actionButton('Remove', async () => {
          changed(await api.del('/api/me/avatar'));
          toast('Your picture is removed');
        }),
      )),
    input);
}

// Whether what you watch shows on other people's Home ("Watched by Others", with your name). Saved as it's switched.
function sharingPanel(user) {
  const share = checkField('Show what I watch to others', user.shareWatching !== false, {
    hint: 'Movies and shows you watch appear in “Watched by Others” on other people’s Home, with your name.',
    onChange: async (on) => {
      share.input.disabled = true;
      try {
        const r = await api.patch('/api/me', { shareWatching: on });
        state.me.user = r.user;
        toast(on ? 'Others can see what you watch' : 'What you watch is now just for you');
      } catch (err) {
        share.input.checked = !on;
        toastError(err);
      } finally {
        share.input.disabled = false;
      }
    },
  });
  return panel('Watched by Others', 'Home has a row of what other people on this Reelhouse have been watching lately.', share.el);
}

// Apps (the Kodi add-on, the Reelhouse app) signed in to this account with their own long-lived sign-in.
function devicesPanel(devices) {
  const addonPage = `${location.origin}/kodi/`;
  const list = h('div.list');
  const show = (items) => list.replaceChildren(...(items.length
    ? items.map(row)
    : [h('p.desc', 'No apps are signed in.')]));
  const tunnelNote = (d) => {
    if (!d.tunnel) return '';
    return d.tunnelHandshakeAt ? ` · app tunnel, connected ${timeAgo(d.tunnelHandshakeAt)}` : ' · app tunnel';
  };
  const row = (d) => h('div.list-row',
    h('div.grow',
      h('div.title', d.name),
      h('div.sub', `Signed in ${timeAgo(d.createdAt)} · last used ${timeAgo(d.lastSeenAt)}${d.ip ? ` · ${d.ip}` : ''}${tunnelNote(d)}`),
    ),
    h('button.btn.btn-icon.btn-danger', {
      'aria-label': `Sign out ${d.name}`,
      title: 'Sign out',
      onClick: async () => {
        if (!(await confirmDialog({
          title: `Sign out ${d.name}?`,
          message: d.tunnel
            ? 'It can’t reach Reelhouse any more, also not through the app tunnel, until it’s paired again.'
            : 'It stops syncing until someone signs in on it again. Items it already synced stay until removed there.',
          confirmLabel: 'Sign out',
          danger: true,
        }))) return;
        try {
          await api.del(`/api/me/devices/${encodeURIComponent(d.id)}`);
          devices = devices.filter((x) => x.id !== d.id);
          show(devices);
          toast(`${d.name} signed out`);
        } catch (err) {
          toastError(err);
        }
      },
    }, icon('signOut', 18)),
  );
  const refresh = async () => {
    devices = (await api.get('/api/me/devices')).devices;
    show(devices);
    return devices;
  };
  show(devices);
  return panel('Apps and devices', null,
    h('p.desc', 'Apps signed in to your account. To add Kodi, install the Reelhouse add-on from ',
      h('a', { href: addonPage, target: '_blank', rel: 'noopener' }, addonPage), '.'),
    list,
    h('div.panel-actions', { style: { marginTop: '16px' } },
      actionButton('Pair the Reelhouse app', () => pairingDialog({ onPaired: refresh }), { icon: icon('link', 16) })),
  );
}
