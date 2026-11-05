import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildCsr } from '../server/remote/acme.js';
import { generateKeyPair, publicKeyFromPrivate } from '../server/remote/wireguard.js';

function opensslAvailable() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('CSR is well-formed and correctly signed', { skip: !opensslAvailable() && 'openssl not installed' }, () => {
  const key = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  const der = buildCsr('media.example.com', key);
  const pem = `-----BEGIN CERTIFICATE REQUEST-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE REQUEST-----\n`;
  const out = execFileSync('openssl', ['req', '-noout', '-verify', '-text'], { input: pem, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  assert.match(out, /CN\s*=\s*media\.example\.com/);
  assert.match(out, /DNS:media\.example\.com/);
});

test('WireGuard keys are base64 Curve25519 pairs', () => {
  const kp = generateKeyPair();
  assert.equal(Buffer.from(kp.privateKey, 'base64').length, 32);
  assert.equal(Buffer.from(kp.publicKey, 'base64').length, 32);
  assert.equal(publicKeyFromPrivate(kp.privateKey), kp.publicKey);
});
