import express from 'express';
import compression from 'compression';
import path from 'node:path';
import { WEB_DIR, ROOT_DIR } from './lib/paths.js';
import { authenticate, csrfGuard } from './auth.js';
import { getSetting } from './settings.js';
import { acmeChallengeResponse } from './remote/tls.js';
import { logger } from './lib/log.js';
import authRoutes from './routes/auth.js';
import libraryRoutes from './routes/library.js';
import playbackRoutes from './routes/playback.js';
import adminRoutes from './routes/admin.js';
import liveTvRoutes from './routes/livetv.js';
import syncRoutes from './routes/sync.js';
import requestRoutes from './routes/requests.js';
import kodiRoutes from './kodi.js';
import androidRoutes from './android.js';

const log = logger('http');

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', !!getSetting('trustProxy'));
  app.set('etag', 'weak');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', CSP);
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    next();
  });

  // gzip JSON, HTML, CSS, JS and playlists. Video (and other already-compressed types) is skipped
  // automatically, so range requests for streams are untouched.
  app.use(compression());

  // Let's Encrypt HTTP-01 challenges (when the main port is 80 or proxied to it).
  app.get('/.well-known/acme-challenge/:token', (req, res) => {
    const value = acmeChallengeResponse(req.params.token);
    if (!value) return res.status(404).end();
    res.type('text/plain').send(value);
  });

  // Liveness probe for Docker/monitoring; no auth, no data.
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.use('/api', express.json({ limit: '1mb' }), authenticate, csrfGuard);
  // adminRoutes guards everything that reaches it (router.use(requireAdmin)), so it goes last.
  app.use('/api', authRoutes, libraryRoutes, playbackRoutes, syncRoutes, liveTvRoutes, requestRoutes, adminRoutes);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // The Kodi add-on, for Kodi's "Install from zip file", and the Android app for phones to install.
  app.use(kodiRoutes, androidRoutes);
  app.use('/vendor/hls', express.static(path.join(ROOT_DIR, 'node_modules', 'hls.js', 'dist'), { maxAge: '7d' }));
  app.use(express.static(WEB_DIR, { index: false, maxAge: 0 }));
  // Single-page app: every other GET serves the shell.
  app.get('/{*splat}', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(WEB_DIR, 'index.html'));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    // Media URLs from apps carry their sign-in token; it stays out of the log.
    if (status >= 500) log.error(`${req.method} ${req.originalUrl.replace(/([?&]X-Reelhouse-Token=)[^&]*/gi, '$1…')}:`, err);
    if (res.headersSent) return;
    res.status(status).json({ error: err.message || 'Server error' });
  });

  return app;
}
