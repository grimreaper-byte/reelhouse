// Settings → Live TV: Reelhouse shows Tvheadend's guide, plays its channels and schedules its recordings. The tab
// checks the connection when it opens, so it says straight away what the Tvheadend account may do, and can delete
// what Reelhouse keeps from Tvheadend (channels, guide, logos) to fetch it all again.
import { h, setChildren } from '../../dom.js';
import { api } from '../../api.js';
import { confirmDialog, statusPill, toast } from '../../components.js';
import { recordingsDrive } from '../livetv.js';
import { textField, checkField, selectField, panel, saveButton, actionButton, loadSettings } from './form.js';

export async function liveTvTab(ctx) {
  const { settings } = await loadSettings(ctx.signal);
  const s = settings.liveTv;
  const enabled = checkField('Turn on Live TV', s.enabled, { hint: 'Adds Live TV to the sidebar for the accounts allowed to use it (Users).' });
  const url = textField('Tvheadend address', s.url, {
    placeholder: 'http://192.168.1.50:9981',
    hint: 'Where Reelhouse reaches Tvheadend, with its web port (9981 unless you changed it) and any web root.',
  });
  const username = textField('Tvheadend username', s.username, { autocomplete: 'off' });
  const password = textField('Tvheadend password', s.password, { secret: true });

  const pill = h('span');
  const result = h('div');
  const profileHolder = h('div');
  let profile = null;
  const showProfiles = (configs) => {
    const options = [{ id: '', label: 'Tvheadend’s default' }, ...configs.map((c) => ({ id: c.uuid, label: c.name }))];
    if (s.dvrConfig && !configs.some((c) => c.uuid === s.dvrConfig)) options.push({ id: s.dvrConfig, label: 'The profile chosen before (no longer listed)' });
    profile = selectField('Recording profile', options, s.dvrConfig, {
      hint: 'Tvheadend’s recording settings (where it saves, how long it keeps recordings, extra time before and after) used when someone records from the guide.',
    });
    setChildren(profileHolder, profile.el);
  };

  const showResult = (r, error) => {
    if (error) {
      setChildren(pill, statusPill(false, 'Not connected'));
      setChildren(result, h('div.callout.bad', error));
      return;
    }
    setChildren(pill, statusPill(r.canStream ? true : 'warn', r.canStream ? 'Connected' : 'Connected, can’t stream'));
    setChildren(result, h('dl.kv',
      h('dt', 'Server'), h('dd', [r.name, r.version].filter(Boolean).join(' ')),
      // Radio stations are those with a "radio" channel tag in Tvheadend (they get their own Radio page).
      h('dt', 'Channels'), h('dd', r.radio ? `${r.channels - r.radio} TV, ${r.radio} radio` : `${r.channels} (no radio stations tagged as radio)`),
      h('dt', 'Watching'), h('dd', r.canStream ? 'Allowed' : r.streamProblem || 'Not allowed'),
      h('dt', 'Recording'), h('dd', r.canRecord ? 'Allowed' : 'Not allowed for this account (give it the “Video recorder” right in Tvheadend)'),
      r.diskSpace && [h('dt', 'Recordings drive'), h('dd', recordingsDrive(r.diskSpace))],
    ));
    if (r.canRecord) showProfiles(r.dvrConfigs);
    else setChildren(profileHolder);
  };

  const check = async (form) => {
    setChildren(pill, statusPill(null, 'Checking…'));
    try {
      const r = await api.post('/api/admin/livetv/test', form);
      showResult(r);
      return r;
    } catch (err) {
      showResult(null, err.message);
      throw err;
    }
  };
  const formValues = () => ({ url: url.value, username: username.value, password: password.value });
  // The saved connection, checked as the tab opens.
  if (s.url) check({}).catch(() => {});

  // What came back after deleting the kept copies and fetching them again.
  const refreshed = h('div');
  const showRefreshed = (r) => setChildren(refreshed, h('dl.kv',
    h('dt', 'Channels'), h('dd', `${r.channels - r.radio} TV, ${r.radio} radio`),
    // Tvheadend can list a logo it can't give, e.g. a picon file named after the channel that isn't there.
    h('dt', 'Logos'), h('dd', !r.withLogo ? 'Tvheadend has none for these channels'
      : `${r.logos} of the ${r.channels} channels${r.logosPending ? ' so far (the rest are still coming)'
        : r.withLogo > r.logos ? `; Tvheadend lists ${r.withLogo - r.logos} more it couldn’t give (asked again in a few hours)` : ''}`),
    h('dt', 'Guide'), h('dd', r.guideError ? `Not fetched: ${r.guideError}`
      : r.programmes ? `${r.programmes.toLocaleString()} programmes in the next 24 hours, on ${r.guideChannels} of the ${r.channels} channels`
        : 'Nothing in the next 24 hours: Tvheadend has no guide yet (see below)'),
  ));
  const refresh = async () => {
    const ok = await confirmDialog({
      title: 'Delete cached guide data?',
      message: 'Reelhouse forgets the channels, guide and logos it kept from Tvheadend, then fetches them again. Guides open elsewhere update within a minute.',
      confirmLabel: 'Delete and fetch again',
    });
    if (!ok) return;
    setChildren(refreshed, h('p.hint', 'Fetching from Tvheadend…'));
    try {
      showRefreshed(await api.post('/api/admin/livetv/refresh'));
      toast('Fetched again from Tvheadend');
    } catch (err) {
      setChildren(refreshed, h('div.callout.bad', err.message));
      throw err;
    }
  };

  return h('div',
    h('h2', 'Live TV'),
    h('p.lead', 'Watch live TV and the TV guide from Tvheadend, and schedule its recordings, from Reelhouse.'),
    panel(h('span', 'Tvheadend ', pill),
      'Reelhouse signs in to Tvheadend with an account of its own, so pick (or make) one for it in Tvheadend.',
      enabled.el, url.el, username.el, password.el,
      result,
      profileHolder,
      h('div.panel-actions',
        saveButton('Save', () => ({
          liveTv: { enabled: enabled.value, ...formValues(), ...(profile ? { dvrConfig: profile.value } : {}) },
        }), { after: () => (url.value ? check({}).catch(() => {}) : null) }),
        actionButton('Test connection', async () => {
          const r = await check(formValues());
          toast(r.canStream ? 'Tvheadend answers' : 'Tvheadend answers, but this account can’t stream');
        }),
      )),
    panel('Guide data kept by Reelhouse', null,
      h('p.hint',
        'Reelhouse keeps copies of what Tvheadend says, so pages open quickly: the channels and the guide for a few minutes, the channel logos for a week, and which stations turned out to be radio when played. ',
        'If the guide, the channels or their logos look wrong or out of date, delete them all and fetch them again (with the saved connection). Nothing is deleted if Tvheadend doesn’t answer.'),
      h('p.hint',
        'If the guide is wrong in Tvheadend too, have Tvheadend fetch it first: in Tvheadend open ', h('b', 'Configuration → Channel / EPG → EPG Grabber'),
        ' and use ', h('b', 'Re-run Internal EPG Grabbers'), ' (XMLTV) or ', h('b', 'Trigger OTA EPG Grabber'), ' (the guide broadcast with the channels, as on Freeview).'),
      refreshed,
      h('div.panel-actions', actionButton('Delete cached guide data and fetch again', refresh))),
    panel('What the Tvheadend account needs', null,
      h('ol.steps',
        h('li', 'In Tvheadend, open ', h('b', 'Configuration → Users → Access Entries'), ' and add an entry for the account (or use an existing one).'),
        h('li', 'Tick ', h('b', 'Web interface'), ', set ', h('b', 'Streaming'), ' to Basic, and — to record from Reelhouse — ', h('b', 'Video recorder'), ' to Basic.'),
        h('li', 'Give it a password under ', h('b', 'Configuration → Users → Passwords'), ', then enter both here.'),
      ),
      h('p.hint', 'Tvheadend’s Digest and Plain sign-in (Configuration → General → Base) both work. Channels this account may not watch don’t appear in Reelhouse.')),
    panel('Who can use it', null,
      h('p.hint', { style: { margin: 0 } },
        'Each account has two switches under ', h('a', { href: '/settings/users' }, 'Users'), ': ',
        h('b', 'Can watch live TV'), ' (on for new accounts) and ', h('b', 'Can schedule recordings'), ' (off until you turn it on). ',
        'Admins can always do both. Watching live TV counts towards an account’s devices playing at once, and each channel being watched uses one of Tvheadend’s tuners until its player closes.')),
    panel('Watching recordings', null,
      h('p.hint', { style: { margin: 0 } },
        'Tvheadend saves recordings in its own recordings folder. Add that folder as a library (',
        h('a', { href: '/settings/libraries' }, 'Libraries'), ') and they appear in Reelhouse like your other films and shows.')),
  );
}
