// What a brand-new server starts with, and that one already in use keeps what it had (migration v18).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, closeDb, get, run } from '../server/db.js';
import { getSetting, isSettingStored } from '../server/settings.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reelhouse-fresh-'));
const file = path.join(tmp, 'reelhouse.db');
const stored = () => get("SELECT value FROM settings WHERE key = 'allowDownloads'")?.value ?? null;

// The server restarting on the new version, with its database as an older version left it.
function upgrade() {
  run('DROP TABLE recording_series'); // v19, after this one
  run('ALTER TABLE users DROP COLUMN live_tv_series');
  run('DROP TABLE channel_views'); // v20
  run('PRAGMA user_version = 17');
  closeDb();
  openDb(file);
}

before(() => openDb(file));
after(() => {
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a brand-new server has downloads off', () => {
  assert.equal(getSetting('allowDownloads'), false);
  assert.equal(isSettingStored('allowDownloads'), false);
});

test('one installed but never set up is as good as new', () => {
  upgrade();
  assert.equal(stored(), null);
});

test('a server in use on the old default keeps downloads on', () => {
  run("INSERT INTO users (username, password_hash, created_at) VALUES ('owner', 'x', 1)");
  upgrade();
  assert.equal(stored(), 'true');
});

test('a server in use that turned downloads off keeps them off', () => {
  run("UPDATE settings SET value = 'false' WHERE key = 'allowDownloads'");
  upgrade();
  assert.equal(stored(), 'false');
});
