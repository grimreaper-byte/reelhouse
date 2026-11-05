// The server's version (package.json, raised with each release) and the commit it was built from, so Settings and
// the startup log line say exactly what is running: Docker builds are given the commit as REELHOUSE_COMMIT (the
// image has no .git); running from a checkout, it's read from .git.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from './lib/paths.js';

export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).version;
export const COMMIT = /^[0-9a-f]{7,40}$/i.test(process.env.REELHOUSE_COMMIT?.trim() || '')
  ? process.env.REELHOUSE_COMMIT.trim().slice(0, 7).toLowerCase()
  : gitCommit();

function gitCommit() {
  try {
    const git = path.join(ROOT_DIR, '.git');
    let head = fs.readFileSync(path.join(git, 'HEAD'), 'utf8').trim();
    const ref = /^ref: (.+)$/.exec(head)?.[1];
    if (ref) {
      const loose = path.join(git, ref);
      head = fs.existsSync(loose) ? fs.readFileSync(loose, 'utf8').trim()
        : fs.readFileSync(path.join(git, 'packed-refs'), 'utf8').split('\n').find((l) => l.endsWith(` ${ref}`))?.split(' ')[0];
    }
    return /^[0-9a-f]{40}$/.test(head || '') ? head.slice(0, 7) : null;
  } catch {
    return null;
  }
}
