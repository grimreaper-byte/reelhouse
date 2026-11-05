// Tiny logger: writes to the console and keeps a ring buffer the admin UI can show.
const MAX_LINES = 1000;
const lines = [];

function write(level, scope, args) {
  const msg = args
    .map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  const entry = { t: Date.now(), level, scope, msg };
  lines.push(entry);
  if (lines.length > MAX_LINES) lines.shift();
  const d = new Date(entry.t);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const out = `${stamp} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  if (level === 'error') console.error(out);
  else if (level === 'warn') console.warn(out);
  else console.log(out);
}

export function logger(scope) {
  return {
    debug: (...a) => process.env.REELHOUSE_DEBUG && write('debug', scope, a),
    info: (...a) => write('info', scope, a),
    warn: (...a) => write('warn', scope, a),
    error: (...a) => write('error', scope, a),
  };
}

export function recentLogs(limit = 300) {
  return lines.slice(-limit);
}
