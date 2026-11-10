import { h, icon, formatTime, formatBytes, clear, episodeLabel } from '../../dom.js';
import { api } from '../../api.js';
import { panel } from './form.js';

export async function activityTab(ctx) {
  const now = h('div');
  const logs = h('div.log-view');
  const info = h('div');

  async function refresh() {
    try {
      const [a, status, l] = await Promise.all([
        api.get('/api/activity'),
        api.get('/api/admin/status'),
        api.get('/api/admin/logs?limit=400'),
      ]);
      if (ctx.signal.aborted) return;
      clear(now).append(a.sessions.length
        ? h('div.list', a.sessions.map((s) => (s.mode === 'live'
          // Live TV: the channel (its icon), what was on when it started, and the quality.
          ? h('div.list-row.activity-card.live',
            h('img', { src: `/api/livetv/channels/${s.channelUuid}/icon`, alt: '', loading: 'lazy', onError: (e) => { e.target.style.visibility = 'hidden'; } }),
            h('div.grow',
              h('div.title', s.title),
              h('div.sub', [s.username, s.client, s.ip].filter(Boolean).join(' · ')),
              h('div.sub', `${s.state === 'paused' ? 'Paused' : 'Playing'} · ${s.radio ? 'Live radio' : `Live TV${s.qualityLabel ? ` (${s.qualityLabel})` : ''}`}`),
              s.programme && h('div.sub', s.programme),
            ))
          : h('div.list-row.activity-card',
            h('img', { src: `/api/images/${s.itemId}/thumb?w=240`, alt: '', loading: 'lazy' }),
            h('div.grow',
              // An episode: its show, then "S1 · E3 — its title", as the player has them.
              h('div.title', s.grandparentTitle || s.title),
              s.grandparentTitle && h('div.sub', [episodeLabel(s), s.title].filter(Boolean).join(' — ')),
              h('div.sub', [s.username, s.client, s.ip].filter(Boolean).join(' · ')),
              h('div.sub', `${s.state === 'paused' ? 'Paused' : 'Playing'} · ${s.mode === 'direct' ? 'Direct play' : s.mode === 'download' ? 'Downloaded copy' : `Converting${s.reasons?.length ? ` (${s.reasons.join(', ')}${s.videoCopy ? '; picture copied' : ''})` : ''}`}`),
              h('div.bar', h('div', { style: { width: `${s.duration && s.position ? Math.min(100, (s.position / s.duration) * 100) : 0}%` } })),
              h('div.sub', s.position == null ? 'Starting…' : `${formatTime(s.position)} / ${formatTime(s.duration)}`),
            )))))
        : h('p.hint', { style: { margin: 0 } }, 'Nobody is watching right now.'));

      const atBottom = logs.scrollTop + logs.clientHeight >= logs.scrollHeight - 20;
      clear(logs).append(...l.logs.map((e) => h(`div${e.level === 'warn' ? '.warn' : e.level === 'error' ? '.error' : ''}`,
        `${new Date(e.t).toLocaleTimeString()} [${e.scope}] ${e.msg}`)));
      if (atBottom) logs.scrollTop = logs.scrollHeight;

      const up = status.uptime;
      clear(info).append(h('dl.kv',
        h('dt', 'Version'), h('dd', status.commit ? `${status.version} (build ${status.commit})` : status.version),
        h('dt', 'System'), h('dd', status.platform),
        h('dt', 'Node.js'), h('dd', status.node),
        h('dt', 'CPU cores'), h('dd', String(status.cpus)),
        h('dt', 'Memory'), h('dd', `${formatBytes(status.memory.total - status.memory.free)} used of ${formatBytes(status.memory.total)}`),
        h('dt', 'Uptime'), h('dd', up > 86400 ? `${Math.floor(up / 86400)} days` : formatTime(up)),
        h('dt', 'Active conversions'), h('dd', String(status.transcodes.filter((t) => t.running).length)),
      ));
    } catch {
      // keep the last good view
    }
  }
  await refresh();
  const timer = setInterval(refresh, 5000);
  ctx.onCleanup(() => clearInterval(timer));
  setTimeout(() => {
    logs.scrollTop = logs.scrollHeight;
  }, 0);

  return h('div',
    h('h2', 'Activity & logs'),
    h('p.lead', 'What’s playing now, and what the server has been up to.'),
    panel('Now playing', null, now),
    panel('Server', null, info),
    panel('Log', 'The most recent server messages. Useful when something isn’t working.', logs,
      h('div.panel-actions', h('button.btn', { onClick: refresh }, icon('refresh', 16), 'Refresh'))),
  );
}
