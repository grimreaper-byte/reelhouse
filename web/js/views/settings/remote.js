import { h, icon, timeAgo, formatDate, formatBytes } from '../../dom.js';
import { api } from '../../api.js';
import { modal, toast, toastError, confirmDialog, statusPill, copyText } from '../../components.js';
import { render } from '../../router.js';
import { panel, textField, selectField, checkField, actionButton, loadSettings } from './form.js';

const DDNS_FIELDS = {
  external: [
    { key: 'hostname', label: 'Hostname', placeholder: 'myhome.ddns.net', hint: 'The name your router (or another program) keeps pointed at your home. Reelhouse checks that it does, and uses it for WireGuard, the app tunnel and HTTPS.' },
  ],
  duckdns: [
    { key: 'hostname', label: 'Subdomain', placeholder: 'myhome  (for myhome.duckdns.org)' },
    { key: 'token', label: 'Token', secret: true, hint: 'Shown at the top of your duckdns.org account page.' },
  ],
  cloudflare: [
    { key: 'hostname', label: 'Hostname', placeholder: 'media.example.com' },
    { key: 'zone', label: 'Zone (your domain)', placeholder: 'example.com — optional' },
    { key: 'token', label: 'API token', secret: true, hint: 'Create a token with the “Edit zone DNS” template, limited to this zone.' },
  ],
  noip: [
    { key: 'hostname', label: 'Hostname', placeholder: 'myhome.ddns.net' },
    { key: 'username', label: 'Username or email' },
    { key: 'password', label: 'Password', secret: true },
  ],
  dyndns2: [
    { key: 'server', label: 'Update server', placeholder: 'api.dynu.com' },
    { key: 'hostname', label: 'Hostname', placeholder: 'myhome.example.net' },
    { key: 'username', label: 'Username' },
    { key: 'password', label: 'Password', secret: true },
  ],
  namecheap: [
    { key: 'hostname', label: 'Hostname', placeholder: 'media.example.com' },
    { key: 'zone', label: 'Domain', placeholder: 'example.com' },
    { key: 'password', label: 'Dynamic DNS password', secret: true, hint: 'From Domain List → Manage → Advanced DNS → Dynamic DNS.' },
  ],
  custom: [
    { key: 'url', label: 'Update URL', placeholder: 'https://example.com/update?host={hostname}&ip={ip}', hint: '{ip} and {hostname} are filled in automatically.' },
    { key: 'hostname', label: 'Hostname', placeholder: 'myhome.example.net' },
  ],
};

const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener', style: { color: 'var(--accent)' } }, text);

export async function remoteTab(ctx) {
  const [{ settings: s, options }, st] = await Promise.all([
    loadSettings(ctx.signal),
    api.get('/api/remote/status', { signal: ctx.signal }),
  ]);
  const lanIp = st.lan.find((a) => !a.wireguard)?.address || 'this-pc';
  const webPort = st.ports.https || st.ports.http;
  const isWindows = st.wireguard.platform === 'win32';

  return h('div',
    h('h2', 'Remote access'),
    h('p.lead', 'Watch your library away from home. First make your home reachable, then pick a way in — one, or more than one.'),
    overviewPanel(st, isWindows),
    h('h2', { style: { margin: '36px 0 6px' } }, 'Make your home reachable'),
    h('p.lead', 'Every way in needs these two: a name that keeps pointing at your home when its IP address changes, and a router that lets the connections through.'),
    ddnsPanel(s, st, options),
    portPanel(s, st, lanIp, webPort),
    h('h2', { style: { margin: '36px 0 6px' } }, 'Pick a way in'),
    appTunnelPanel(s, st),
    wireguardPanel(s, st, isWindows),
    directPanel(s, st, webPort),
  );
}

// Shown when devices would be given the public IP itself, which stops working when the provider changes it.
function bareIpWarning(st, field, who, consequence) {
  if (field.trim() || st.ddns.hostname) return null;
  return h('div.callout', { style: { marginTop: '14px' } },
    st.publicIp
      ? [`${who} your current public IP (`, h('span.mono', st.publicIp), `). If your internet provider changes it, ${consequence}. Set up dynamic DNS in step 1 above — or, if your IP never changes, type it in “Address devices connect to” to hide this.`]
      : `Reelhouse doesn’t know your public IP yet, so ${who.toLowerCase()} no outside address. Set up dynamic DNS in step 1 above, or type your address in “Address devices connect to”.`);
}

// ---------- overview ----------

function overviewPanel(st, isWindows) {
  return panel('Status', null,
    st.cgnat ? h('div.callout.bad',
      h('strong', 'Your internet provider appears to use carrier-grade NAT (CGNAT). '),
      'Your router doesn’t have its own public IP address, so port forwarding — needed by every way in below — won’t work. Ask your ISP for a public IPv4 address (often free on request), or use a relay service such as Tailscale or Cloudflare Tunnel.') : null,
    st.container && !st.hostNetwork ? h('div.callout',
      h('strong', 'Running in a container. '),
      'The addresses below are inside the container — use your host machine’s IP instead. Automatic router setup (UPnP) only works with host networking (network_mode: host); otherwise forward the ports manually.') : null,
    st.container && st.hostNetwork ? h('p.hint', { style: { marginTop: 0 } },
      'Running in a container with host networking: these are the host’s own addresses, and Reelhouse’s ports need no publishing in Docker.') : null,
    h('dl.kv',
      h('dt', 'At home'), h('dd', st.lan.filter((a) => !a.wireguard).map((a) => h('div.mono', `http://${a.address}:${st.ports.http}`))),
      h('dt', 'Public IP'), h('dd', st.publicIp ? h('span.mono', st.publicIp) : statusPill(false, st.publicIpError || 'unknown')),
      h('dt', 'Web listener'), h('dd', listenerLine(st.listeners)),
    ),
    isWindows && h('div', { style: { marginTop: '16px' } },
      h('p.hint', 'Windows Firewall may block connections that come through a VPN tunnel or from the internet. This adds an inbound rule for Reelhouse’s ports (Windows will ask for admin permission on this PC’s screen).'),
      actionButton('Allow through Windows Firewall', async () => {
        const r = await api.post('/api/remote/firewall');
        toast(`Firewall rule added for TCP ${r.ports.join(', ')}`);
      }, { icon: icon('shield', 16) })),
  );
}

function listenerLine(l) {
  const parts = [];
  if (l.http) parts.push(l.http.listening ? statusPill(true, `HTTP on ${l.http.port}`) : statusPill(false, l.http.error));
  if (l.https) parts.push(' ', l.https.listening ? statusPill(true, `HTTPS on ${l.https.port}`) : statusPill('warn', `HTTPS: ${l.https.error}`));
  return parts;
}

// ---------- WireGuard ----------

function wireguardPanel(s, st, isWindows) {
  const wg = st.wireguard;
  const enabled = checkField('Use WireGuard', s.wireguard.enabled, { hint: 'Also opens the WireGuard port through UPnP when that’s turned on in step 2.' });
  const port = textField('WireGuard port (UDP)', s.wireguard.listenPort, { type: 'number' });
  const endpoint = textField('Address devices connect to', s.wireguard.endpoint, {
    placeholder: wg.endpoint || st.publicIp || 'your public IP or DDNS hostname',
    hint: 'Leave empty to use your dynamic DNS name (step 1). A name keeps working when your IP changes.',
  });
  const subnet = textField('Tunnel subnet', s.wireguard.subnet, { mono: true, hint: wg.peers.length ? 'Remove all devices to change it.' : 'Private range used inside the tunnel.' });
  const dns = textField('DNS for devices (optional)', s.wireguard.dns, { placeholder: 'e.g. 1.1.1.1' });
  subnet.input.disabled = wg.peers.length > 0;

  const save = actionButton('Save', async () => {
    await api.put('/api/settings', {
      wireguard: { enabled: enabled.value, listenPort: port.value, endpoint: endpoint.value, subnet: subnet.value, dns: dns.value },
    });
    toast('Saved');
    render();
  }, { primary: true });

  const serverUrl = `http://${wg.serverAddress}:${st.ports.http}`;
  const devices = h('div.list', wg.peers.map((p) => h('div.list-row',
    icon('key', 20),
    h('div.grow', h('div.title', p.name), h('div.sub', `${p.address} · added ${timeAgo(p.createdAt)}`)),
    h('button.btn.btn-sm', { onClick: () => showPeer(p.id) }, 'Show QR'),
    h('a.btn.btn-sm.btn-icon', { href: `/api/remote/wireguard/peers/${p.id}/download`, 'aria-label': 'Download config', download: '' }, icon('download', 16)),
    h('button.btn.btn-sm.btn-icon.btn-danger', {
      'aria-label': `Remove ${p.name}`,
      onClick: async () => {
        if (!(await confirmDialog({ title: `Remove ${p.name}?`, message: 'This device will no longer be able to connect. Re-install the tunnel on this PC afterwards to apply the change.', confirmLabel: 'Remove', danger: true }))) return;
        try {
          await api.del(`/api/remote/wireguard/peers/${p.id}`);
          render();
        } catch (err) {
          toastError(err);
        }
      },
    }, icon('trash', 16)),
  )));

  return h('section.panel',
    h('h3', icon('shield', 20), 'Option 2: WireGuard VPN ', statusPill(wg.enabled && wg.configured ? true : null, wg.enabled && wg.configured ? 'Enabled' : 'Recommended')),
    h('p.desc', 'For any device, not just the Reelhouse app: web browsers on laptops, iPhones and iPads, Kodi. Your phone or laptop joins a private encrypted tunnel to this PC. Reelhouse itself stays invisible to the internet — only WireGuard’s port is open, and it silently ignores anyone without a key. Needs the free WireGuard app on this machine and on each device (Windows, macOS, Linux, iOS, Android).'),
    !wg.configured
      ? h('div',
        h('ol.steps',
          h('li', isWindows ? [wg.windowsInstalled ? statusPill(true, 'Installed') : null, ' Install ', link('https://www.wireguard.com/install/', 'WireGuard for Windows'), ' on this PC.'] : [`Install WireGuard on ${st.container ? 'the Docker host' : 'this server'} (`, h('code', 'sudo apt install wireguard'), ' or see ', link('https://www.wireguard.com/install/', 'wireguard.com'), ').']),
          h('li', 'Generate the server keys below.'),
        ),
        actionButton('Generate server keys', async () => {
          await api.post('/api/remote/wireguard/init');
          await api.put('/api/settings', { wireguard: { enabled: true } });
          render();
        }, { primary: true, icon: icon('key', 16) }))
      : h('div',
        h('div.form-grid', port.el, endpoint.el, subnet.el, dns.el),
        enabled.el,
        h('div.panel-actions', save),
        bareIpWarning(st, s.wireguard.endpoint, 'Devices get', 'they stop connecting until you edit the address on each one or add them again'),
        h('h3', { style: { margin: '26px 0 10px', fontSize: '16px' } }, 'Set up this computer'),
        h('ol.steps',
          isWindows
            ? h('li',
              wg.windowsInstalled ? 'WireGuard is installed. ' : ['Install ', link('https://www.wireguard.com/install/', 'WireGuard for Windows'), '. '],
              'Click “Install tunnel on this PC” (Windows asks for admin permission), or import ', h('code', 'reelhouse.conf'), ' in the WireGuard app with “Import tunnel(s) from file”.')
            : st.container
              ? h('li', 'Run WireGuard on the Docker host (not in this container): copy ', h('code', 'wireguard/reelhouse.conf'),
                ' from your mapped config folder to ', h('code', '/etc/wireguard/'), ' on the host and run ',
                h('code', 'sudo systemctl enable --now wg-quick@reelhouse'), '. Devices then reach Reelhouse through the host’s published port.')
              : h('li', 'Run ', h('code', `sudo cp "${wg.configPath}" /etc/wireguard/reelhouse.conf`), ' then ',
                h('code', 'sudo systemctl enable --now wg-quick@reelhouse'), '.'),
          h('li', 'Forward ', h('strong', `UDP port ${s.wireguard.listenPort}`), ' on your router to this computer (step 2 above).'),
          h('li', isWindows
            ? 'Re-install the tunnel whenever you add or remove a device.'
            : ['After adding or removing a device, copy the file again and run ', h('code', 'sudo systemctl restart wg-quick@reelhouse'), '.']),
        ),
        h('div.panel-actions',
          isWindows && wg.windowsInstalled && actionButton('Install tunnel on this PC', async () => {
            await api.post('/api/remote/wireguard/install-windows');
            toast('Tunnel installed and started');
          }, { primary: true, icon: icon('shield', 16) }),
          h('a.btn', { href: '/api/remote/wireguard/server.conf', download: '' }, icon('download', 16), 'Download server config'),
        ),
        h('h3', { style: { margin: '26px 0 10px', fontSize: '16px' } }, 'Devices'),
        wg.peers.length ? devices : h('p.hint', 'No devices yet. Add one for each phone, tablet or laptop.'),
        h('div.panel-actions', { style: { marginTop: '12px' } },
          h('button.btn.btn-primary', { onClick: addPeer }, icon('plus', 16), 'Add device')),
        h('div.callout', { style: { marginTop: '18px', marginBottom: 0 } },
          'On a device: turn the tunnel on in the WireGuard app, then open ', h('code', serverUrl), ' in a browser. ',
          h('button.btn.btn-sm.btn-ghost', { onClick: () => copyText(serverUrl) }, icon('copy', 14), 'Copy')),
      ),
  );
}

function addPeer() {
  const name = h('input.input', { id: 'peer-name', placeholder: 'e.g. My phone', maxlength: 60 });
  modal({
    title: 'Add a device',
    body: h('div.field', h('label', { for: 'peer-name' }, 'Device name'), name),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Create',
        primary: true,
        onClick: async () => {
          const r = await api.post('/api/remote/wireguard/peers', { name: name.value.trim() || 'Device' });
          peerModal(r, true);
          render();
        },
      },
    ],
  });
}

async function showPeer(id) {
  try {
    peerModal(await api.get(`/api/remote/wireguard/peers/${id}`), false);
  } catch (err) {
    toastError(err);
  }
}

function peerModal({ peer, config, qr }, isNew) {
  modal({
    title: peer.name,
    wide: true,
    body: h('div',
      isNew && h('div.callout', 'Device added. Re-install the tunnel on this PC (button above) so it accepts the new device.'),
      h('p.hint', { style: { textAlign: 'center' } }, 'Phone or tablet: in the WireGuard app tap + → “Scan from QR code”.'),
      h('div.qr', { html: qr }),
      h('p.hint', 'Computer: download the file and use “Import tunnel(s) from file”. Keep this config private — it’s the key to your server.'),
      h('pre.code', config),
    ),
    actions: [
      { label: 'Copy', onClick: () => { copyText(config); return true; } },
      { label: 'Download .conf', onClick: () => { location.href = `/api/remote/wireguard/peers/${peer.id}/download`; return true; } },
      { label: 'Done', primary: true },
    ],
  });
}

// ---------- app tunnel ----------

function appTunnelPanel(s, st) {
  const t = st.appTunnel;
  const enabled = checkField('Use the app tunnel', s.appTunnel.enabled, { hint: 'Also opens its port through UPnP when that’s turned on in step 2.' });
  const port = textField('App tunnel port (UDP)', s.appTunnel.listenPort, { type: 'number' });
  const endpoint = textField('Address devices connect to', s.appTunnel.endpoint, {
    placeholder: t.endpoint || st.publicIp || 'your public IP or DDNS hostname',
    hint: 'Leave empty to use your dynamic DNS name (step 1), or else your public IP. Goes into each pairing code.',
  });
  const subnet = textField('Tunnel subnet', s.appTunnel.subnet, { mono: true, hint: t.peers.length ? 'Sign out the paired apps to change it.' : 'Private range used inside the tunnel. Must differ from WireGuard’s.' });
  subnet.input.disabled = t.peers.length > 0;

  const save = actionButton('Save', async () => {
    await api.put('/api/settings', { appTunnel: { enabled: enabled.value, listenPort: port.value, endpoint: endpoint.value, subnet: subnet.value } });
    toast('Saved');
    render();
  }, { primary: true });

  const peerLine = (p) => {
    if (p.pending) return `${p.address} · waiting for its pairing code to be used`;
    const seen = p.lastHandshake ? `connected ${timeAgo(p.lastHandshake)}` : 'not connected since Reelhouse started';
    return `${p.user} · ${p.address} · ${seen}${p.rxBytes || p.txBytes ? ` · ${formatBytes(p.txBytes)} sent` : ''}`;
  };
  const devices = h('div.list', t.peers.map((p) => h('div.list-row',
    icon('key', 20),
    h('div.grow', h('div.title', p.name), h('div.sub', peerLine(p))),
    h('button.btn.btn-sm.btn-icon.btn-danger', {
      'aria-label': `Remove ${p.name}`,
      onClick: async () => {
        if (!(await confirmDialog({ title: `Remove ${p.name}?`, message: 'The device can’t use the tunnel any more (it stays signed in at home). It would need pairing again.', confirmLabel: 'Remove', danger: true }))) return;
        try {
          await api.del(`/api/remote/app-tunnel/peers/${p.id}`);
          render();
        } catch (err) {
          toastError(err);
        }
      },
    }, icon('trash', 16)),
  )));

  const state = !t.enabled ? null : t.running ? true : 'warn';
  return h('section.panel',
    h('h3', icon('link', 20), 'Option 1: Reelhouse app tunnel ', statusPill(state, !t.enabled ? 'Off' : t.running ? 'Running' : 'Not running')),
    h('p.desc', 'The simplest way in if you only use Android phones and tablets away from home. It’s built into Reelhouse and the Reelhouse app, so there’s no WireGuard to install, on this machine or on the phone. Only the app’s traffic goes through it, so other VPNs keep working. Devices join by pairing (Your account → Apps and devices), nothing is restarted for that, and nothing but Reelhouse can be reached through it. For web browsers, iPhones or Kodi, use Option 2 as well.'),
    !t.helperInstalled && h('div.callout.bad', 'The tunnel helper isn’t installed on this machine. It comes with the Docker image; for a Windows or Linux install, build it from ', h('code', 'tunnel/'), ' (see ', h('code', 'tunnel/README.md'), ').'),
    t.enabled && t.error && t.helperInstalled && h('div.callout.bad', t.error),
    h('div.form-grid', port.el, endpoint.el, subnet.el),
    enabled.el,
    h('div.panel-actions', save),
    t.enabled && bareIpWarning(st, s.appTunnel.endpoint, 'Pairing codes get', 'paired apps can’t connect from outside until they’ve been back on your home network'),
    t.enabled && h('ol.steps', { style: { marginTop: '18px' } },
      st.container && !st.hostNetwork
        ? h('li', 'Publish the port in Docker: add ', h('code', `"${t.listenPort}:${t.listenPort}/udp"`), ' under ', h('code', 'ports:'), ' in your compose file (not needed with host networking).')
        : null,
      h('li', 'Forward ', h('strong', `UDP port ${t.listenPort}`), ' on your router to this ', st.container ? 'Docker host' : 'computer', ' (step 2 above).'),
      h('li', 'Pair each phone from Your account → Apps and devices. Inside the tunnel the app reaches Reelhouse at ', h('code', `http://${t.address}`), '.'),
    ),
    t.peers.length ? [h('h3', { style: { margin: '26px 0 10px', fontSize: '16px' } }, 'Paired devices'), devices] : null,
  );
}

// ---------- DDNS ----------

function ddnsPanel(s, st, options) {
  const cfg = s.ddns;
  const fieldsBox = h('div');
  const inputs = {};
  let provider = cfg.provider;
  const renderFields = () => {
    fieldsBox.replaceChildren();
    for (const k of Object.keys(inputs)) delete inputs[k];
    for (const f of DDNS_FIELDS[provider] || []) {
      const field = textField(f.label, cfg[f.key], { secret: f.secret, placeholder: f.placeholder, hint: f.hint });
      inputs[f.key] = field;
      fieldsBox.append(field.el);
    }
    if (provider === 'duckdns') fieldsBox.prepend(h('p.hint', 'Free and quick: sign in at ', link('https://www.duckdns.org', 'duckdns.org'), ', create a subdomain, and copy your token.'));
    if (provider === 'noip') fieldsBox.prepend(h('p.hint', 'Free hostnames at ', link('https://www.noip.com', 'noip.com'), ' must be confirmed every 30 days.'));
  };
  const providerSel = selectField('Provider', options.ddnsProviders.map((p) => ({ id: p.id, label: p.label })), provider, {
    onChange: (v) => {
      provider = v;
      renderFields();
    },
  });
  const interval = textField('Check every (minutes)', cfg.intervalMinutes, { type: 'number', min: 1 });
  renderFields();
  const status = st.ddns;
  const external = status.provider === 'external';
  return h('section.panel',
    h('h3', '1. Dynamic DNS ', status.provider !== 'none' ? statusPill(status.ok === true ? true : status.ok === false ? false : null, status.ok === false ? 'Failing' : status.ok ? 'Working' : 'Waiting') : null),
    h('p.desc', 'Home internet connections usually get a new public IP from time to time. A dynamic DNS name always points at your current one, so WireGuard devices, paired apps and web links keep working when it changes.'),
    h('p.hint', 'Already have a name that your router (or another program) keeps updated? Choose “Updated elsewhere”. Choose None only if your public IP never changes.'),
    providerSel.el,
    fieldsBox,
    interval.el,
    status.provider !== 'none' && h('dl.kv', { style: { margin: '6px 0 14px' } },
      h('dt', 'Hostname'), h('dd.mono', status.hostname || '—'),
      h('dt', 'Last result'), h('dd', status.message || '—'),
      external
        ? [h('dt', 'Last check'), h('dd', status.lastCheck ? timeAgo(status.lastCheck) : 'never')]
        : [h('dt', 'Last update'), h('dd', status.lastUpdate ? timeAgo(status.lastUpdate) : 'never')],
    ),
    h('div.panel-actions',
      actionButton('Save', async () => {
        const ddns = { provider, intervalMinutes: interval.value };
        for (const [k, f] of Object.entries(inputs)) ddns[k] = f.value;
        await api.put('/api/settings', { ddns });
        toast('Saved');
        setTimeout(render, 1500);
      }, { primary: true }),
      status.provider !== 'none' && actionButton(external ? 'Check now' : 'Update now', async () => {
        const r = await api.post('/api/remote/ddns/update');
        if (r.ddns.ok === false) throw new Error(r.ddns.message);
        toast(r.ddns.message || 'Updated');
        render();
      }),
    ),
  );
}

// ---------- port forwarding ----------

function portPanel(s, st, lanIp, webPort) {
  const upnp = st.upnp;
  const enabled = checkField('Configure my router automatically (UPnP)', s.upnp.enabled, { hint: 'Works if UPnP is turned on in your router. Mappings are renewed every 30 minutes and removed when Reelhouse stops.' });
  const openWeb = checkField('Also open the web port (only needed for Option 3, a web address)', !!s.upnp.openWebPort, { hint: 'Leave this off if you only use the app tunnel or WireGuard: Reelhouse then stays hidden from the internet.' });
  const external = textField('Outside web port (optional)', s.upnp.externalPort || '', { type: 'number', placeholder: String(webPort), hint: 'Use a different outside port than the inside one if you like.' });
  const rules = [
    st.appTunnel.enabled && `UDP  ${st.ports.appTunnel}  →  ${lanIp}:${st.ports.appTunnel}   (Option 1: Reelhouse app tunnel)`,
    st.wireguard.configured && `UDP  ${st.ports.wireguard}  →  ${lanIp}:${st.ports.wireguard}   (Option 2: WireGuard)`,
    `TCP  ${s.upnp.externalPort || webPort}  →  ${lanIp}:${webPort}   (Option 3: web address${st.ports.https ? ', HTTPS' : ''} — only if you use it)`,
  ].filter(Boolean);
  return h('section.panel',
    h('h3', '2. Port forwarding ', upnp.enabled ? statusPill(upnp.ok === true ? true : upnp.ok === false ? false : null, upnp.ok ? 'Active' : upnp.ok === false ? 'Failed' : 'Pending') : null),
    h('p.desc', `Your router must pass incoming connections on to this ${st.container ? 'Docker host' : 'computer'}. Only open the ports of the ways in you use.`),
    h('p.hint', 'To do it by hand, add a port-forwarding rule in your router’s admin page:'),
    h('pre.code', rules.join('\n')),
    enabled.el,
    openWeb.el,
    external.el,
    upnp.enabled && h('dl.kv', { style: { margin: '6px 0 14px' } },
      h('dt', 'Router'), h('dd', upnp.gateway?.model || (upnp.ok === false ? '—' : 'searching…')),
      h('dt', 'Router’s public IP'), h('dd.mono', upnp.externalIp || '—'),
      h('dt', 'Result'), h('dd', upnp.message || '—'),
    ),
    h('div.panel-actions',
      actionButton('Save', async () => {
        await api.put('/api/settings', { upnp: { enabled: enabled.value, openWebPort: openWeb.value, externalPort: Number(external.input.value) || 0 } });
        toast('Saved');
        setTimeout(render, 2500);
      }, { primary: true }),
      upnp.enabled && actionButton('Retry now', async () => {
        const r = await api.post('/api/remote/upnp/apply');
        if (r.upnp.ok === false) throw new Error(r.upnp.message);
        toast('Router configured');
        render();
      }),
    ),
  );
}

// ---------- direct access (web address + HTTPS) ----------

function directPanel(s, st, webPort) {
  const cfg = s.https;
  const tls = st.tls;
  let mode = cfg.mode;
  const modeSel = selectField('HTTPS', [
    { id: 'off', label: 'Off' },
    { id: 'letsencrypt', label: 'Free certificate from Let’s Encrypt (automatic)' },
    { id: 'custom', label: 'Use my own certificate files' },
  ], mode, { onChange: (v) => { mode = v; renderBody(); } });
  const port = textField('HTTPS port', cfg.port, { type: 'number' });
  const domain = textField('Domain name', cfg.domain || st.ddns.hostname, { placeholder: 'myhome.duckdns.org', hint: 'Must point at your public IP (dynamic DNS, step 1).' });
  const email = textField('Email (optional)', cfg.email, { type: 'email', hint: 'Let’s Encrypt only uses it for expiry warnings.' });
  const challenge = selectField('Verification method', [
    { id: 'dns-01', label: `DNS record via your DDNS provider${st.ddns.supportsDnsChallenge ? '' : ' (needs Duck DNS or Cloudflare)'}` },
    { id: 'http-01', label: 'HTTP on port 80 (port 80 must be forwarded to this PC)' },
  ], cfg.challenge);
  const staging = checkField('Test mode (staging certificates, not trusted by browsers)', cfg.staging);
  const tos = checkField(['I agree to the ', link('https://letsencrypt.org/repository/', 'Let’s Encrypt Subscriber Agreement')], cfg.agreeTos);
  const certPath = textField('Certificate file (PEM, full chain)', cfg.certPath, { mono: true, placeholder: 'C:\\certs\\fullchain.pem' });
  const keyPath = textField('Private key file (PEM)', cfg.keyPath, { mono: true, placeholder: 'C:\\certs\\privkey.pem' });
  const body = h('div');

  const renderBody = () => {
    body.replaceChildren();
    if (mode === 'off') {
      body.append(h('p.hint', 'Without HTTPS, passwords and video cross the internet unencrypted. Fine at home or over WireGuard; not recommended for direct access.'));
      return;
    }
    body.append(port.el);
    if (mode === 'letsencrypt') body.append(domain.el, email.el, challenge.el, staging.el, tos.el);
    if (mode === 'custom') body.append(certPath.el, keyPath.el);
  };
  renderBody();

  const cert = tls.certificate;
  const host = st.ddns.hostname || st.publicIp;
  const url = host && `${st.ports.https ? 'https' : 'http'}://${host}:${Number(s.upnp.externalPort) || webPort}`;
  const sub = (...children) => h('h3', { style: { margin: '26px 0 10px', fontSize: '16px' } }, ...children);
  return h('section.panel',
    h('h3', icon('globe', 20), 'Option 3: Direct access with a web address ', statusPill(null, 'Not recommended')),
    h('p.desc', 'Reach Reelhouse from any browser at an address like https://myhome.duckdns.org:8443 — no app needed. This puts the sign-in page on the internet, where anyone can find it, so use it only if Options 1 and 2 don’t suit you, and then with HTTPS and strong passwords. Needs the web port forwarded (step 2).'),
    sub('HTTPS ', cert && !cert.error ? statusPill(cert.validTo > Date.now(), cert.validTo > Date.now() ? 'Certificate valid' : 'Expired') : null),
    h('p.hint', 'Encrypts the connection so nobody between you and your home can read passwords or see what you watch.'),
    modeSel.el,
    body,
    cert && h('dl.kv', { style: { margin: '6px 0 14px' } },
      cert.error ? [h('dt', 'Certificate'), h('dd', statusPill(false, cert.error))] : [
        h('dt', 'Issued for'), h('dd.mono', cert.altNames || cert.subject),
        h('dt', 'Issuer'), h('dd', cert.issuer),
        h('dt', 'Expires'), h('dd', formatDate(new Date(cert.validTo).toISOString().slice(0, 10))),
      ],
    ),
    tls.message && h('p.hint', tls.ok === false ? statusPill(false, tls.message) : tls.message),
    h('div.panel-actions',
      actionButton('Save', async () => {
        const https = { mode, port: port.value };
        if (mode === 'letsencrypt') Object.assign(https, { domain: domain.value, email: email.value, challenge: challenge.value, staging: staging.value, agreeTos: tos.value });
        if (mode === 'custom') Object.assign(https, { certPath: certPath.value, keyPath: keyPath.value });
        await api.put('/api/settings', { https });
        toast('Saved');
        setTimeout(render, 800);
      }, { primary: true }),
      cfg.mode === 'letsencrypt' && actionButton('Get certificate now', async () => {
        toast('Requesting a certificate — this can take a minute or two…', { ms: 8000 });
        await api.post('/api/remote/tls/issue');
        toast('Certificate installed');
        render();
      }, { icon: icon('lock', 16) }),
    ),
    url && [
      sub('Your web address'),
      h('p.hint', 'Once the steps are done, open this from outside your home (test it on mobile data, not your Wi-Fi):'),
      h('div.input-row', h('input.input.mono', { value: url, readonly: true, 'aria-label': 'Your web address' }), h('button.btn', { onClick: () => copyText(url) }, icon('copy', 16), 'Copy')),
    ],
  );
}
