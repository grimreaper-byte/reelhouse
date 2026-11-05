import { h } from '../dom.js';
import { isAdmin } from '../state.js';
import { navigate } from '../router.js';
import { scrollArrows } from '../components.js';
import { accountTab } from './settings/account.js';
import { generalTab, transcoderTab, metadataTab } from './settings/server.js';
import { librariesTab } from './settings/libraries.js';
import { usersTab } from './settings/users.js';
import { remoteTab } from './settings/remote.js';
import { androidTab } from './settings/android.js';
import { kodiTab } from './settings/kodi.js';
import { liveTvTab } from './settings/livetv.js';
import { activityTab } from './settings/activity.js';

const TABS = [
  { id: 'general', label: 'General', admin: true, view: generalTab },
  { id: 'libraries', label: 'Libraries', admin: true, view: librariesTab },
  { id: 'users', label: 'Users', admin: true, view: usersTab },
  { id: 'remote', label: 'Remote access', admin: true, view: remoteTab },
  { id: 'android', label: 'Android app', admin: true, view: androidTab },
  { id: 'kodi', label: 'Kodi add-on', admin: true, view: kodiTab },
  { id: 'livetv', label: 'Live TV', admin: true, view: liveTvTab },
  { id: 'transcoder', label: 'Transcoder', admin: true, view: transcoderTab },
  { id: 'metadata', label: 'Metadata', admin: true, view: metadataTab },
  { id: 'activity', label: 'Activity & logs', admin: true, view: activityTab },
  { id: 'account', label: 'Your account', admin: false, view: accountTab },
];

export async function settingsView(ctx) {
  const tabs = TABS.filter((t) => !t.admin || isAdmin());
  const tab = tabs.find((t) => t.id === ctx.params.tab) || (ctx.params.tab ? null : tabs[0]);
  if (!tab) {
    navigate(`/settings/${tabs[0].id}`, { replace: true });
    return h('div');
  }
  const content = await tab.view(ctx);
  // In a narrow window the tabs are one row across the top: arrows at its ends scroll it (a mouse can't swipe), and
  // the open tab is brought into view rather than left off the end.
  const nav = h('nav.settings-nav', tabs.map((t) => h(`a${t.id === tab.id ? '.active' : ''}`, { href: `/settings/${t.id}` }, t.label)));
  const { prev, next } = scrollArrows(nav);
  const reveal = new ResizeObserver(() => {
    reveal.disconnect();
    const active = nav.querySelector('a.active');
    if (!active || nav.scrollWidth <= nav.clientWidth + 1) return;
    const a = active.getBoundingClientRect();
    const n = nav.getBoundingClientRect();
    nav.scrollLeft += a.left + a.width / 2 - (n.left + n.width / 2);
  });
  reveal.observe(nav);
  return h('div.page',
    h('h1.page-title', 'Settings'),
    h('div.settings',
      h('div.settings-tabs', prev, nav, next),
      h('div.settings-content', content),
    ),
  );
}
