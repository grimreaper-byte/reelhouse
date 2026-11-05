// HTTPS certificates: either user-provided files, or issued/renewed automatically by Let's Encrypt.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { getSetting } from '../settings.js';
import { dirs } from '../lib/paths.js';
import { AcmeClient, ACME_DIRECTORIES, waitForTxt } from './acme.js';
import { setAcmeTxt } from './ddns.js';
import { logger } from '../lib/log.js';

const log = logger('tls');
const httpChallenges = new Map(); // token -> keyAuthorization
const state = { issuing: false, message: null, ok: null, lastAttempt: null };
let renewTimer = null;
let onCertificateChange = () => {};

export function onCertChange(fn) {
  onCertificateChange = fn;
}

const leFiles = (domain) => ({
  cert: path.join(dirs.tls, `${domain}.crt`),
  key: path.join(dirs.tls, `${domain}.key`),
});
const accountKeyFile = (staging) => path.join(dirs.tls, staging ? 'acme-account-staging.key' : 'acme-account.key');

/** Returns { cert, key } PEM strings for the configured mode, or null. */
export function loadTlsFiles() {
  const cfg = getSetting('https');
  try {
    if (cfg.mode === 'custom' && cfg.certPath && cfg.keyPath) {
      return { cert: fs.readFileSync(cfg.certPath, 'utf8'), key: fs.readFileSync(cfg.keyPath, 'utf8') };
    }
    if (cfg.mode === 'letsencrypt' && cfg.domain) {
      const f = leFiles(cfg.domain);
      if (fs.existsSync(f.cert) && fs.existsSync(f.key)) {
        return { cert: fs.readFileSync(f.cert, 'utf8'), key: fs.readFileSync(f.key, 'utf8') };
      }
    }
  } catch (err) {
    log.error(`Cannot read certificate: ${err.message}`);
  }
  return null;
}

export function certificateInfo() {
  const files = loadTlsFiles();
  if (!files) return null;
  try {
    const x = new crypto.X509Certificate(files.cert);
    return {
      subject: x.subject.replace(/\n/g, ', '),
      issuer: x.issuer.split('\n').find((l) => l.startsWith('O=') || l.startsWith('CN='))?.slice(3) || x.issuer,
      validFrom: new Date(x.validFrom).getTime(),
      validTo: new Date(x.validTo).getTime(),
      altNames: x.subjectAltName || null,
    };
  } catch (err) {
    return { error: `Unreadable certificate: ${err.message}` };
  }
}

export function tlsStatus() {
  return { ...state, certificate: certificateInfo() };
}

// Served by the main app (and by a temporary listener on port 80 during issuance).
export function acmeChallengeResponse(token) {
  return httpChallenges.get(token) || null;
}

// Let's Encrypt always connects to port 80 from outside. Inside Docker, or as a non-root user on
// Linux, listen on another port (e.g. 8080) and forward external port 80 to it.
const challengePort = () => Number(process.env.REELHOUSE_ACME_PORT) || 80;

async function withPort80Listener(fn) {
  const port = challengePort();
  if (Number(getSetting('port')) === port) return fn();
  const server = http.createServer((req, res) => {
    const m = req.url.match(/^\/\.well-known\/acme-challenge\/([\w-]+)$/);
    const value = m && httpChallenges.get(m[1]);
    if (!value) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' }).end(value);
  });
  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') reject(new Error(`Port ${port} is in use by another program`));
      else if (err.code === 'EACCES') {
        reject(new Error(`Not allowed to listen on port ${port}. Use the DNS verification method, or set REELHOUSE_ACME_PORT=8080 and forward external port 80 to it.`));
      } else reject(err);
    });
    server.listen(port, resolve);
  });
  try {
    return await fn();
  } finally {
    server.close();
  }
}

export async function issueCertificate() {
  const cfg = getSetting('https');
  if (cfg.mode !== 'letsencrypt') throw new Error("HTTPS mode is not set to Let's Encrypt");
  if (!cfg.domain) throw new Error('Set the domain name first');
  if (!cfg.agreeTos) throw new Error("You need to accept the Let's Encrypt Subscriber Agreement");
  if (state.issuing) throw new Error('Already requesting a certificate');
  state.issuing = true;
  state.lastAttempt = Date.now();
  state.message = 'Requesting certificate…';
  try {
    const accountFile = accountKeyFile(cfg.staging);
    const client = new AcmeClient({
      directoryUrl: cfg.staging ? ACME_DIRECTORIES.staging : ACME_DIRECTORIES.production,
      accountKeyPem: fs.existsSync(accountFile) ? fs.readFileSync(accountFile, 'utf8') : null,
      log: (m) => {
        state.message = m;
        log.info(m);
      },
    });
    fs.mkdirSync(dirs.tls, { recursive: true });
    fs.writeFileSync(accountFile, client.accountKeyPem(), { mode: 0o600 });

    const presenter = cfg.challenge === 'dns-01'
      ? {
        present: async ({ domain, dnsValue }) => {
          await setAcmeTxt(domain, dnsValue);
          state.message = 'Waiting for the DNS record to propagate…';
          await waitForTxt(`_acme-challenge.${domain}`, dnsValue);
        },
        cleanup: ({ domain }) => setAcmeTxt(domain, null),
      }
      : {
        present: async ({ token, keyAuthorization }) => httpChallenges.set(token, keyAuthorization),
        cleanup: async ({ token }) => httpChallenges.delete(token),
      };

    const run = () => client.issue({ domain: cfg.domain.trim(), email: cfg.email.trim(), challengeType: cfg.challenge, presenter });
    const { certPem, keyPem } = cfg.challenge === 'http-01' ? await withPort80Listener(run) : await run();
    const f = leFiles(cfg.domain.trim());
    fs.writeFileSync(f.key, keyPem, { mode: 0o600 });
    fs.writeFileSync(f.cert, certPem);
    state.ok = true;
    state.message = `Certificate issued${cfg.staging ? ' (staging — not trusted by browsers)' : ''}`;
    log.info(state.message);
    onCertificateChange();
  } catch (err) {
    state.ok = false;
    state.message = err.message;
    log.error(`Certificate request failed: ${err.message}`);
    throw err;
  } finally {
    state.issuing = false;
  }
}

async function renewIfNeeded() {
  const cfg = getSetting('https');
  if (cfg.mode !== 'letsencrypt' || !cfg.domain || !cfg.agreeTos || state.issuing) return;
  const info = certificateInfo();
  const daysLeft = info?.validTo ? (info.validTo - Date.now()) / 86400000 : -1;
  // Retry failed attempts at most every 6 hours.
  if (state.ok === false && Date.now() - (state.lastAttempt || 0) < 6 * 3600 * 1000) return;
  if (!info || info.error || daysLeft < 30) {
    log.info(info ? `Certificate expires in ${Math.floor(daysLeft)} days, renewing` : 'No certificate yet, requesting one');
    await issueCertificate().catch(() => {});
  }
}

export function startCertRenewal() {
  clearInterval(renewTimer);
  setTimeout(() => void renewIfNeeded(), 15000).unref();
  renewTimer = setInterval(() => void renewIfNeeded(), 12 * 3600 * 1000);
  renewTimer.unref();
}
