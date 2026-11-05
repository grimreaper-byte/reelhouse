// Kodi add-on settings tab: what the add-on does, what to watch out for, and how to install it from this server's
// /kodi/ page, plus the Kodis signed in to any account.
import { h, icon, timeAgo } from '../../dom.js';
import { api } from '../../api.js';
import { copyText } from '../../components.js';
import { panel } from './form.js';

export async function kodiTab(ctx) {
  const { addon, addresses, devices } = await api.get('/api/admin/kodi-addon', { signal: ctx.signal });
  // Kodi needs an address it can reach: the first one Reelhouse knows for itself, else the one this page uses.
  const sourceUrl = addresses[0] || `${location.origin}/kodi/`;
  return h('div',
    h('h2', 'Kodi add-on'),
    h('p.lead', 'Reelhouse for Kodi puts your movies and shows into Kodi’s own library.'),
    aboutPanel(),
    warningsPanel(),
    installPanel(addon, sourceUrl, addresses),
    goodToKnowPanel(),
    devicesPanel(devices),
  );
}

function aboutPanel() {
  return panel('What it does', null,
    h('ul.plain-list',
      h('li', h('strong', 'Reelhouse’s own screens: '), 'Open Reelhouse in the add-on shows Reelhouse as this web app looks — the sidebar, Home, libraries, film and show pages, search, the live TV guide and your recordings — driven with the remote. Back never leaves it; Exit at the bottom of its sidebar returns to Kodi, and Now playing at the top of it returns to whatever’s playing. It can open by itself when Kodi starts (the add-on’s settings).'),
      h('li', h('strong', 'Kodi’s own library: '), 'titles appear in Kodi’s Movies and TV Shows, home-screen widgets, search and any skin, with posters, backgrounds, cast photos, plots, ratings and media flags.'),
      h('li', h('strong', 'Watched marks both ways: '), 'resume points and watched marks from Kodi reach Reelhouse straight away, and ones made elsewhere reach Kodi within seconds.'),
      h('li', h('strong', 'Keeps up by itself: '), 'when Reelhouse adds, changes or removes something, Kodi follows within seconds; a full check also runs when Kodi starts and every hour.'),
      h('li', h('strong', 'The original file: '), 'Kodi plays nearly every format itself, so it streams the file as it is; nothing is converted. Subtitle files next to the video come along.'),
      h('li', h('strong', 'One person’s library: '), 'each Kodi signs in as one Reelhouse user and shows only their libraries and watch history. When Kodi starts, a notification says who it’s signed in as.'),
    ));
}

function warningsPanel() {
  const warn = (title, text) => h('div.callout', h('strong', title), ' ', text);
  return panel('Before you install', null,
    warn('Start with an empty Kodi library.',
      'The add-on writes Reelhouse’s titles straight into Kodi’s video database. If this Kodi already has the same movies or shows from its own sources, every one of them shows up twice. A fresh Kodi install (or a new Kodi profile) is the cleanest start; otherwise remove those video sources, and the titles they added, from Kodi first. If the library holds anything you want to keep, back up Kodi’s userdata folder before you start.'),
    warn('Don’t add your media to Kodi yourself.',
      'Don’t add your media folders as a Kodi video source or scan them into Kodi’s library: Reelhouse fills the library for you. Add, fix and remove titles in Reelhouse, and Kodi follows.'),
    warn('Kodi 21 “Omega”, with its own (local) library.',
      'That’s the version it’s tested with; Kodi 19 and 20 should work but are untested. A shared MySQL/MariaDB library isn’t supported (the add-on says so instead of syncing).'),
  );
}

function installPanel(addon, sourceUrl, addresses) {
  const home = sourceUrl.replace(/\/kodi\/$/, '');
  const code = (text) => h('code', text);
  const others = addresses.slice(1);
  return panel('Installing it', null,
    h('dl.kv',
      h('dt', 'Add-on'), h('dd', `Reelhouse ${addon.version}`),
      h('dt', 'File'), h('dd', h('a', { href: `/kodi/${encodeURIComponent(addon.fileName)}` }, addon.fileName), ` · ${Math.ceil(addon.size / 1024)} KB`),
      h('dt', 'Install page'), h('dd', h('span.mono', sourceUrl), ' ',
        h('button.btn.btn-ghost.btn-icon.btn-sm', { type: 'button', 'aria-label': 'Copy the address', title: 'Copy', onClick: () => copyText(sourceUrl) }, icon('copy', 16)))),
    others.length ? h('p.hint', 'Reelhouse also answers at ', others.map((a, i) => [i ? ', ' : '', h('span.mono', a)]), '. Use whichever the Kodi device can reach.') : null,
    h('ol.steps',
      h('li', 'In Kodi, open ', h('strong', 'Settings → System → Add-ons'), ' and turn on ', h('strong', 'Unknown sources'), ' (Kodi asks you to confirm).'),
      h('li', 'Open ', h('strong', 'Settings → File manager → Add source'), ', enter ', code(sourceUrl), ' and name it ', code('Reelhouse'), '.'),
      h('li', 'Go to ', h('strong', 'Add-ons → Install from zip file → Reelhouse'), ' and choose ', code(addon.fileName), '.'),
      h('li', 'Open ', h('strong', 'Add-ons → Video add-ons → Reelhouse → Sign in to Reelhouse…'), ' and enter ', code(home),
        ', then the username and password of the person whose library this Kodi should show.'),
    ),
    h('p.hint', 'The first sync starts straight away; the movies and shows then appear under Movies and TV Shows. To update the add-on later, repeat step 3 with the newer zip: Kodi keeps its settings and sign-in.'),
  );
}

function goodToKnowPanel() {
  return panel('Good to know', null,
    h('ul.plain-list',
      h('li', 'Reelhouse has to be reachable when you press play. Away from home, use ', h('a', { href: '/settings/remote' }, 'WireGuard'),
        ' or Reelhouse’s HTTPS address with a certificate Kodi trusts (e.g. Let’s Encrypt; self-signed ones don’t work).'),
      h('li', 'Each Kodi has its own sign-in, lasting a year from when it was last used. People see theirs under Your account → Apps and devices and can sign one out there; changing the password signs out every Kodi too.'),
      h('li', 'Kodi’s Clean library and Update library leave the synced titles alone.'),
      h('li', 'Before uninstalling the add-on, choose ', h('strong', 'Remove Reelhouse items from Kodi'), ' in its settings. Your other Kodi media isn’t touched.'),
      h('li', 'The sign-in is part of the artwork and video addresses inside Kodi’s database, so sign a Kodi out before giving the device away.'),
    ));
}

function devicesPanel(devices) {
  return panel('Signed in Kodi devices', null,
    devices.length
      ? h('div.list', devices.map((d) => h('div.list-row',
        h('div.grow',
          h('div.title', d.name),
          h('div.sub', `Signed in as ${d.user} · ${timeAgo(d.createdAt)} · last used ${timeAgo(d.lastSeenAt)}${d.ip ? ` · ${d.ip}` : ''}`)))))
      : h('p.hint', { style: { margin: 0 } }, 'Not signed in to any Kodi devices.'),
    devices.length ? h('p.hint', 'To sign one out, its owner uses Your account → Apps and devices, or you use Users → Edit → Sign out all devices.') : null,
  );
}
