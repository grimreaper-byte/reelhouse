import { h } from '../../dom.js';
import { api } from '../../api.js';
import { modal, toast, copyText } from '../../components.js';

/**
 * Shows a one-time pairing code (and its QR code) for the Reelhouse app and waits for the app to use it.
 * For your own account by default; an admin passes `user` ({ id, username }) to pair a phone for someone else
 * (Settings → Users). `onPaired` runs once the app has used the code.
 */
export async function pairingDialog({ user = null, onPaired } = {}) {
  const base = user ? `/api/users/${user.id}/pairings` : '/api/me/pairings';
  const p = await api.post(base);
  const countdown = h('span');
  let timer = null;
  let poll = null;
  let used = false;
  const stop = () => {
    clearInterval(timer);
    clearInterval(poll);
  };
  // Closed without being used: the code (and its tunnel key) shouldn't linger.
  const cancel = () => {
    stop();
    if (!used) api.del(`${base}/${p.id}`).catch(() => {});
  };
  const tick = () => {
    const left = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
    countdown.textContent = left
      ? `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
      : 'Expired. Close this and make a new one.';
    if (!left) stop();
  };
  const dialog = modal({
    title: user ? `Pair the Reelhouse app for ${user.username}` : 'Pair the Reelhouse app',
    body: h('div',
      user && h('div.callout', `The phone that uses this code is signed in as ${user.username}, with their libraries and watch history.`),
      h('p.hint', { style: { textAlign: 'center' } }, 'In the Reelhouse app, scan this code, or (at home) type the code below.'),
      h('div.qr', { html: p.qr }),
      h('div.pair-code', { 'aria-label': 'Pairing code' }, p.code),
      h('p.hint', { style: { textAlign: 'center' } }, countdown, ' · works once'),
      ...p.warnings.map((w) => h('div.callout', w)),
      p.tunnel
        ? h('p.hint', 'Away from home the app connects through Reelhouse’s app tunnel: only the app’s own traffic goes through it, nothing else on the phone.')
        : h('p.hint', 'The app tunnel is off, so away from home the app can only use Reelhouse’s HTTPS address (if set up). An admin can turn the tunnel on in Settings → Remote access.'),
      h('p.hint', user
        ? `Give this code or link only to ${user.username}: until it’s used, it signs a device in to their account.`
        : 'Keep this code to yourself until it’s used: it signs a device in to your account.'),
      p.app && h('details.get-app',
        h('summary', 'Don’t have the app yet?'),
        p.app.qr
          ? [
            h('p.hint', { style: { textAlign: 'center' } }, `Scan this with the phone’s camera to download Reelhouse ${p.app.versionName}, install it, then scan the pairing code above from the app.`),
            h('div.qr', { html: p.app.qr }),
            h('p.hint', { style: { textAlign: 'center' } }, h('a', { href: p.app.url, target: '_blank', rel: 'noopener' }, p.app.url)),
          ]
          : h('p.hint', 'Open this server’s /android/ page on the phone (at the address you use at home) to download the app.')),
    ),
    actions: [
      { label: 'Copy link', onClick: () => { copyText(p.link); return true; } },
      { label: 'Done', primary: true },
    ],
    wide: false,
    onClose: cancel,
  });
  tick();
  timer = setInterval(tick, 1000);
  // Follows this pairing (not just any new sign-in) and closes once the app has used it.
  poll = setInterval(async () => {
    if (!document.body.contains(dialog.el)) return stop();
    try {
      const st = await api.get(`${base}/${p.id}`);
      if (st.status === 'used') {
        used = true;
        stop();
        dialog.close();
        toast(user ? `${st.device} is paired for ${user.username}` : `${st.device} is paired`);
        await onPaired?.();
      }
    } catch {
      // try again on the next tick
    }
  }, 2000);
}
