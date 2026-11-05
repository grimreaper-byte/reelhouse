// HTTP Digest authentication for Tvheadend (server/livetv/digest.js), against the RFCs' own examples.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestAuthorization, parseChallenges, pickDigest } from '../server/livetv/digest.js';

const responseOf = (header) => /response="([0-9a-f]+)"/.exec(header)[1];

test('RFC 7616 examples: MD5 and SHA-256', () => {
  const common = {
    username: 'Mufasa', password: 'Circle of Life', method: 'GET', uri: '/dir/index.html', nc: 1,
    cnonce: 'f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ',
  };
  const params = { realm: 'http-auth@example.org', qop: 'auth, auth-int', nonce: '7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v', opaque: 'FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS' };
  assert.equal(responseOf(digestAuthorization({ ...common, params: { ...params, algorithm: 'MD5' } })), '8ca523f5e9506fed4657c9700eebdbec');
  const sha = digestAuthorization({ ...common, params: { ...params, algorithm: 'SHA-256' } });
  assert.equal(responseOf(sha), '753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1');
  assert.match(sha, /qop=auth, nc=00000001, cnonce="f2\/wE4q74E6zIJEtWaHKaf5wv\/H5QzzpXusqGemxURZJ", opaque="FQhe/);
});

test('RFC 2617 example: no algorithm named means MD5', () => {
  const header = digestAuthorization({
    params: { realm: 'testrealm@host.com', qop: 'auth,auth-int', nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093', opaque: '5ccc069c403ebaf9f0171e9517f40e41' },
    username: 'Mufasa', password: 'Circle Of Life', method: 'GET', uri: '/dir/index.html', nc: 1, cnonce: '0a4f113b',
  });
  assert.equal(responseOf(header), '6629fae49393a05397450978507c4ef1');
});

test('challenges: several in one header (as fetch joins them), quoted commas, the strongest Digest picked', () => {
  const header = 'Basic realm="tvheadend", Digest realm="tvheadend", qop="auth", nonce="abc,def", opaque="o", algorithm=MD5, '
    + 'Digest realm="tvheadend", qop="auth", nonce="n2", opaque="o", algorithm=SHA-256';
  const challenges = parseChallenges(header);
  assert.deepEqual(challenges.map((c) => c.scheme), ['basic', 'digest', 'digest']);
  assert.equal(challenges[1].params.nonce, 'abc,def');
  assert.equal(pickDigest(challenges).params.algorithm, 'SHA-256');
  assert.equal(pickDigest(parseChallenges('Basic realm="x"')), null);
  // Tvheadend's SHA-512/256 setting.
  const sha512 = digestAuthorization({ params: { realm: 'r', nonce: 'n', qop: 'auth', algorithm: 'SHA-512-256' }, username: 'u', password: 'p', method: 'GET', uri: '/', cnonce: 'c' });
  assert.match(sha512, /algorithm=SHA-512-256, response="[0-9a-f]{64}"/);
});
