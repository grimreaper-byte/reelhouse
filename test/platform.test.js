import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isPathInside } from '../server/lib/platform.js';

const win = process.platform === 'win32';

test('isPathInside handles nested paths and siblings', () => {
  const root = path.resolve(win ? 'C:\\Media\\Movies' : '/media/movies');
  assert.equal(isPathInside(path.join(root, 'Heat (1995)', 'Heat.mkv'), root), true);
  assert.equal(isPathInside(root, root), true);
  assert.equal(isPathInside(`${root} 4K${path.sep}x.mkv`, root), false, 'sibling folder with a common prefix');
  assert.equal(isPathInside(path.dirname(root), root), false);
  assert.equal(isPathInside(path.join(root, '..foo', 'x.mkv'), root), true, 'child named "..foo"');
});

test('isPathInside works for drive/filesystem roots', () => {
  // Regression: "E:\" + separator used to match nothing, so every scan deleted the library.
  const root = win ? 'E:\\' : '/';
  const file = win ? 'E:\\Movies\\Heat.mkv' : '/movies/heat.mkv';
  assert.equal(isPathInside(file, root), true);
});

test('case sensitivity follows the platform', () => {
  const root = win ? 'C:\\Media' : '/media';
  const other = win ? 'c:\\MEDIA\\x.mkv' : '/MEDIA/x.mkv';
  assert.equal(isPathInside(other, root), win);
});
