// Recognises requests that came through the app tunnel. The tunnel helper (on this machine) adds the secret it was
// started with and the device's tunnel address; nobody else knows the secret, which changes on every start.
import crypto from 'node:crypto';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
let secret = null;

/** Set by the tunnel manager when it starts the helper (null when it isn't running). */
export function setTunnelSecret(value) {
  secret = value || null;
}

/** The device's tunnel address when this request came through the app tunnel, else null. */
export function tunnelClientAddress(req) {
  const claimed = req.headers?.['x-reelhouse-tunnel'];
  if (!claimed || !secret || !LOOPBACK.has(req.socket?.remoteAddress)) return null;
  const a = Buffer.from(String(claimed));
  const b = Buffer.from(secret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const peer = String(req.headers['x-reelhouse-tunnel-peer'] || '');
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(peer) ? peer : null;
}
