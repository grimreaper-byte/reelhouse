import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { openDb, closeDb, run } from '../server/db.js';
import { loadUser } from '../server/auth.js';
import { openEventStream, libraryChanged, metadataProgress, eventClientCount, defaultsChanged } from '../server/events.js';

const t = Date.now();
before(() => {
  openDb(':memory:');
  run("INSERT INTO libraries (id, name, type, paths, created_at) VALUES (1, 'Movies', 'movie', '[]', ?), (2, 'Kids', 'movie', '[]', ?)", t, t);
  run("INSERT INTO users (id, username, password_hash, is_admin, library_access, created_at) VALUES (1, 'admin', 'x', 1, NULL, ?), (2, 'kid', 'x', 0, '[2]', ?)", t, t);
});
after(() => closeDb());

// Minimal stand-ins for Express's req/res.
function connect(userId) {
  const req = new EventEmitter();
  const res = {
    chunks: [],
    ended: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    write(s) { this.chunks.push(s); },
    end() { this.ended = true; },
  };
  const state = { user: loadUser(userId) };
  openEventStream(req, res, () => state.user);
  const events = (type) => res.chunks.filter((c) => c.startsWith(`event: ${type}\n`))
    .map((c) => JSON.parse(c.split('\ndata: ')[1]));
  return { req, res, state, events, close: () => req.emit('close') };
}

test('stream opens with a hello carrying the current version, uncompressed', () => {
  const c = connect(1);
  assert.equal(c.res.status, 200);
  assert.match(c.res.headers['Content-Type'], /text\/event-stream/);
  assert.match(c.res.headers['Cache-Control'], /no-transform/);
  const [hello] = c.res.chunks.join('').match(/event: hello\ndata: (.*)\n/).slice(1).map(JSON.parse);
  assert.ok(hello.version);
  c.close();
});

test('library changes reach only users who can see that library', () => {
  const admin = connect(1);
  const kid = connect(2);
  libraryChanged(1, { added: 1 });
  libraryChanged(2, { added: 2 });
  assert.deepEqual(admin.events('library').map((e) => [e.libraryId, e.added]), [[1, 1], [2, 2]]);
  assert.deepEqual(kid.events('library').map((e) => e.libraryId), [2]);
  // Every change bumps the version, so a page that reconnects can tell it missed something.
  const [a, b] = admin.events('library').map((e) => e.version);
  assert.notEqual(a, b);
  admin.close();
  kid.close();
});

test('a deleted library is announced to everyone', () => {
  const kid = connect(2);
  libraryChanged(1, { deleted: true });
  assert.deepEqual(kid.events('library').map((e) => [e.libraryId, e.deleted]), [[1, true]]);
  kid.close();
});

test('changed app defaults reach every user', () => {
  const admin = connect(1);
  const kid = connect(2);
  defaultsChanged({ remoteQuality: '4m-720', allowDownloads: false });
  for (const c of [admin, kid]) assert.deepEqual(c.events('defaults'), [{ remoteQuality: '4m-720', allowDownloads: false }]);
  admin.close();
  kid.close();
});

test('a signed-out session is dropped instead of getting more events', () => {
  const c = connect(1);
  const before = eventClientCount();
  c.state.user = null;
  libraryChanged(1, { added: 1 });
  assert.equal(c.res.ended, true);
  assert.equal(c.events('library').length, 0);
  assert.equal(eventClientCount(), before - 1);
});

test('closing the page removes the client', () => {
  const before = eventClientCount();
  const c = connect(1);
  assert.equal(eventClientCount(), before + 1);
  c.close();
  assert.equal(eventClientCount(), before);
});

test('metadata progress updates pages at the end, not for every item', () => {
  const c = connect(1);
  const seen = [];
  const progress = metadataProgress(1, (done, total) => seen.push(`${done}/${total}`));
  progress(0, 3);
  progress(1, 3);
  progress(2, 3);
  assert.equal(c.events('library').length, 0); // throttled mid-way
  progress(3, 3);
  assert.deepEqual(c.events('library').map((e) => e.metadata), [true]);
  assert.deepEqual(seen, ['0/3', '1/3', '2/3', '3/3']); // the scanner's own progress still sees every step
  // Nothing to fetch: no event.
  metadataProgress(1)(0, 0);
  assert.equal(c.events('library').length, 1);
  c.close();
});
