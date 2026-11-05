// Minimal ACME (RFC 8555) client for Let's Encrypt, built on node:crypto — no dependencies.
import crypto from 'node:crypto';
import dns from 'node:dns/promises';

export const ACME_DIRECTORIES = {
  production: 'https://acme-v02.api.letsencrypt.org/directory',
  staging: 'https://acme-staging-v02.api.letsencrypt.org/directory',
};

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- DER helpers for the CSR ----------

function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag, ...content) => {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
};
const seq = (...c) => tlv(0x30, ...c);
const set = (...c) => tlv(0x31, ...c);

function oid(dotted) {
  const parts = dotted.split('.').map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (const p of parts.slice(2)) {
    const chunk = [p & 0x7f];
    let v = Math.floor(p / 128);
    while (v > 0) {
      chunk.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** PKCS#10 certificate signing request for `domain` signed with an EC P-256 key. */
export function buildCsr(domain, privateKey) {
  const spki = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const subject = seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(domain, 'utf8')))));
  const sanValue = seq(tlv(0x82, Buffer.from(domain, 'ascii'))); // GeneralNames { dNSName }
  const extensionRequest = seq(
    oid('1.2.840.113549.1.9.14'),
    set(seq(seq(oid('2.5.29.17'), tlv(0x04, sanValue)))),
  );
  const info = seq(Buffer.from([0x02, 0x01, 0x00]), subject, spki, tlv(0xa0, extensionRequest));
  const signature = crypto.sign('sha256', info, privateKey);
  return seq(info, seq(oid('1.2.840.10045.4.3.2')), tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
}

// ---------- client ----------

export class AcmeClient {
  constructor({ directoryUrl, accountKeyPem, log = () => {} }) {
    this.directoryUrl = directoryUrl;
    this.accountKey = accountKeyPem
      ? crypto.createPrivateKey(accountKeyPem)
      : crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    const jwk = crypto.createPublicKey(this.accountKey).export({ format: 'jwk' });
    this.jwk = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
    this.thumbprint = b64u(sha256(JSON.stringify(this.jwk)));
    this.nonce = null;
    this.kid = null;
    this.log = log;
  }

  accountKeyPem() {
    return this.accountKey.export({ type: 'pkcs8', format: 'pem' });
  }

  async directory() {
    if (!this.dir) {
      const res = await fetch(this.directoryUrl, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`ACME directory: HTTP ${res.status}`);
      this.dir = await res.json();
    }
    return this.dir;
  }

  async getNonce() {
    if (this.nonce) {
      const n = this.nonce;
      this.nonce = null;
      return n;
    }
    const res = await fetch((await this.directory()).newNonce, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
    return res.headers.get('replay-nonce');
  }

  async post(url, payload, attempt = 0) {
    const header = { alg: 'ES256', nonce: await this.getNonce(), url, ...(this.kid ? { kid: this.kid } : { jwk: this.jwk }) };
    const protectedB64 = b64u(JSON.stringify(header));
    const payloadB64 = payload === '' ? '' : b64u(JSON.stringify(payload));
    const signature = crypto.sign('sha256', Buffer.from(`${protectedB64}.${payloadB64}`), {
      key: this.accountKey,
      dsaEncoding: 'ieee-p1363',
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/jose+json' },
      body: JSON.stringify({ protected: protectedB64, payload: payloadB64, signature: b64u(signature) }),
      signal: AbortSignal.timeout(30000),
    });
    this.nonce = res.headers.get('replay-nonce');
    const isJson = (res.headers.get('content-type') || '').includes('json');
    const body = isJson ? await res.json() : await res.text();
    if (!res.ok) {
      if (body?.type === 'urn:ietf:params:acme:error:badNonce' && attempt < 3) return this.post(url, payload, attempt + 1);
      throw new Error(`ACME: ${body?.detail || body?.type || `HTTP ${res.status}`}`);
    }
    return { body, location: res.headers.get('location') };
  }

  async register(email) {
    const dir = await this.directory();
    const res = await this.post(dir.newAccount, {
      termsOfServiceAgreed: true,
      ...(email ? { contact: [`mailto:${email}`] } : {}),
    });
    this.kid = res.location;
  }

  async poll(url, done, { tries = 40, delayMs = 3000 } = {}) {
    for (let i = 0; i < tries; i++) {
      const { body } = await this.post(url, '');
      const result = done(body);
      if (result) return body;
      await sleep(delayMs);
    }
    throw new Error('ACME: timed out waiting for the CA');
  }

  /**
   * Issues a certificate. `presenter` publishes the challenge:
   *   { present({ type, token, keyAuthorization, dnsValue }), cleanup(...) }
   */
  async issue({ domain, email, challengeType, presenter }) {
    await this.register(email);
    const dir = await this.directory();
    const order = await this.post(dir.newOrder, { identifiers: [{ type: 'dns', value: domain }] });
    const orderUrl = order.location;

    for (const authzUrl of order.body.authorizations) {
      const { body: authz } = await this.post(authzUrl, '');
      if (authz.status === 'valid') continue;
      const challenge = authz.challenges.find((c) => c.type === challengeType);
      if (!challenge) throw new Error(`Let's Encrypt did not offer a ${challengeType} challenge`);
      const keyAuthorization = `${challenge.token}.${this.thumbprint}`;
      const info = { type: challengeType, domain, token: challenge.token, keyAuthorization, dnsValue: b64u(sha256(keyAuthorization)) };
      this.log(`Publishing ${challengeType} challenge for ${domain}`);
      await presenter.present(info);
      try {
        await this.post(challenge.url, {});
        await this.poll(authzUrl, (a) => {
          if (a.status === 'valid') return true;
          if (a.status === 'invalid') {
            const detail = a.challenges.find((c) => c.type === challengeType)?.error?.detail;
            throw new Error(`Validation failed: ${detail || 'unknown reason'}`);
          }
          return false;
        });
      } finally {
        await presenter.cleanup(info).catch(() => {});
      }
    }

    const certKey = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    await this.post(order.body.finalize, { csr: b64u(buildCsr(domain, certKey)) });
    const finalOrder = await this.poll(orderUrl, (o) => {
      if (o.status === 'invalid') throw new Error('Order became invalid');
      return o.status === 'valid';
    });
    const { body: certPem } = await this.post(finalOrder.certificate, '');
    return { certPem, keyPem: certKey.export({ type: 'pkcs8', format: 'pem' }) };
  }
}

/** Waits until public resolvers see the TXT record (DNS-01 propagation). */
export async function waitForTxt(name, value, { timeoutMs = 180000 } = {}) {
  const resolver = new dns.Resolver();
  resolver.setServers(['1.1.1.1', '8.8.8.8']);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const records = await resolver.resolveTxt(name);
      if (records.some((r) => r.join('') === value)) {
        await sleep(5000); // let other resolvers catch up
        return true;
      }
    } catch {
      // NXDOMAIN / no data yet
    }
    await sleep(5000);
  }
  return false;
}
