// Android app settings tab: the app's APK, which phones download from /android/ (the server can't build it itself),
// and where phones are paired and reach Reelhouse from away.
import { h, icon, timeAgo } from '../../dom.js';
import { api } from '../../api.js';
import { toast, confirmDialog } from '../../components.js';
import { render } from '../../router.js';
import { panel, actionButton } from './form.js';

export async function androidTab(ctx) {
  const { app } = await api.get('/api/admin/android-app', { signal: ctx.signal });
  return h('div',
    h('h2', 'Android app'),
    h('p.lead', 'Reelhouse for Android: phones install it from this server, pair with it, and play at home or away.'),
    apkPanel(app),
    panel('Pairing phones', null,
      h('p.hint', { style: { margin: 0 } },
        'Each person pairs their phone from ', h('a', { href: '/settings/account' }, 'Your account → Apps and devices'),
        ' (Pair the Reelhouse app), or you make the code for them in ', h('a', { href: '/settings/users' }, 'Users'), ' (the link button next to each person): scan the QR code in the app. Away from home the app uses the app tunnel, set up in ',
        h('a', { href: '/settings/remote' }, 'Remote access'), '.')),
  );
}

function apkPanel(app) {
  const page = `${location.origin}/android/`;
  const file = h('input', {
    type: 'file',
    accept: '.apk,application/vnd.android.package-archive',
    hidden: true,
    onChange: async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      toast(`Uploading ${f.name}…`);
      try {
        const res = await api.upload('/api/admin/android-app', f, { type: 'application/vnd.android.package-archive' });
        toast(`Reelhouse for Android ${res.app.versionName} is ready at /android/`);
        render();
      } catch (err) {
        toast(err.message, { error: true, ms: 8000 });
      }
    },
  });
  const status = app
    ? h('dl.kv',
      h('dt', 'Version'), h('dd', app.versionName),
      h('dt', 'Size'), h('dd', `${(app.size / 1024 / 1024).toFixed(1)} MB`),
      h('dt', 'Added'), h('dd', timeAgo(app.uploadedAt)),
      h('dt', 'Download page'), h('dd', h('a', { href: page, target: '_blank', rel: 'noopener' }, page)))
    : h('p.hint', { style: { margin: 0 } }, 'Not added yet. Download the APK from the ',
      h('a', { href: 'https://github.com/grimreaper-byte/reelhouse/releases/latest', target: '_blank', rel: 'noopener' }, 'latest release'),
      ' (or build it from the ', h('code', 'android'), ' folder: see ', h('code', 'android/README.md'), ') and upload it here.');
  return panel('Reelhouse for Android',
    'Phones download the app from this server’s /android/ page, and the pairing screen offers it too. Upload a new build to update it; phones install it over the old one.',
    status, file,
    h('div.panel-actions',
      actionButton(app ? 'Upload a new version' : 'Upload the APK', () => file.click(), { icon: icon('upload', 16) }),
      app && actionButton('Remove', async () => {
        if (!(await confirmDialog({
          title: 'Remove the Android app?',
          message: 'Phones that have it keep working; the download page just has nothing to offer until you upload it again.',
          confirmLabel: 'Remove',
          danger: true,
        }))) return;
        await api.del('/api/admin/android-app');
        render();
      }, { danger: true })));
}
