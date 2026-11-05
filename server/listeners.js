// HTTP and HTTPS listeners, restartable when ports or certificates change.
import http from 'node:http';
import https from 'node:https';
import { getSetting, settingsEvents } from './settings.js';
import { loadTlsFiles } from './remote/tls.js';
import { logger } from './lib/log.js';

const log = logger('server');
let app = null;
let httpServer = null;
let httpsServer = null;
const status = { http: null, https: null };

export function listenerStatus() {
  return structuredClone(status);
}

function listen(server, port, host, kind) {
  return new Promise((resolve) => {
    const onError = (err) => {
      status[kind] = { port, listening: false, error: err.code === 'EADDRINUSE' ? `Port ${port} is already in use` : err.message };
      log.error(`${kind.toUpperCase()} listener failed: ${status[kind].error}`);
      resolve(false);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      status[kind] = { port, listening: true, error: null };
      resolve(true);
    });
  });
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

export async function startListeners(expressApp = app) {
  app = expressApp;
  await stopListeners();
  const host = getSetting('bindAddress') || '0.0.0.0';
  httpServer = http.createServer(app);
  await listen(httpServer, Number(getSetting('port')), host, 'http');
  await startHttps();
}

async function startHttps() {
  const cfg = getSetting('https');
  await closeServer(httpsServer);
  httpsServer = null;
  status.https = null;
  if (cfg.mode === 'off') return;
  const files = loadTlsFiles();
  if (!files) {
    status.https = { port: cfg.port, listening: false, error: 'No certificate yet' };
    return;
  }
  try {
    httpsServer = https.createServer({ cert: files.cert, key: files.key }, app);
  } catch (err) {
    status.https = { port: cfg.port, listening: false, error: `Invalid certificate: ${err.message}` };
    log.error(status.https.error);
    return;
  }
  await listen(httpsServer, Number(cfg.port), getSetting('bindAddress') || '0.0.0.0', 'https');
}

/** Swaps in a renewed certificate without dropping connections (or starts HTTPS if it wasn't running). */
export async function reloadCertificate() {
  const files = loadTlsFiles();
  if (httpsServer && files) {
    try {
      httpsServer.setSecureContext({ cert: files.cert, key: files.key });
      log.info('Loaded new HTTPS certificate');
      return;
    } catch (err) {
      log.error(`Could not load certificate: ${err.message}`);
    }
  }
  await startHttps();
}

export async function stopListeners() {
  await Promise.all([closeServer(httpServer), closeServer(httpsServer)]);
  httpServer = null;
  httpsServer = null;
}

settingsEvents.on('change', (changed) => {
  if (!app) return;
  if ('port' in changed || 'bindAddress' in changed) {
    // Give the settings response time to reach the browser before the socket closes.
    setTimeout(() => void startListeners(), 500);
  } else if (changed.https) {
    setTimeout(() => void startHttps(), 200);
  }
});
