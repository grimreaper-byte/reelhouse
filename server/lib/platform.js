import fs from 'node:fs';
import path from 'node:path';

export const isWindows = process.platform === 'win32';
export const isMac = process.platform === 'darwin';
export const isLinux = process.platform === 'linux';

let docker = null;
/** True when running inside a container (Docker, Podman, Kubernetes). */
export function inContainer() {
  if (docker === null) {
    docker = fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv') || !!process.env.REELHOUSE_DOCKER;
  }
  return docker;
}

let detected = null;
/**
 * True when a container shares the host's network (Docker's `network_mode: host`), so its addresses are the host's
 * and phones at home can reach them. REELHOUSE_HOST_NETWORK=1 or 0 overrides the detection.
 */
export function hostNetwork() {
  if (!inContainer()) return false;
  const env = String(process.env.REELHOUSE_HOST_NETWORK ?? '').toLowerCase();
  if (['1', 'true', 'yes'].includes(env)) return true;
  if (['0', 'false', 'no'].includes(env)) return false;
  detected ??= detectHostNetwork();
  return detected;
}

/**
 * A container on a network of its own only has virtual interfaces, each paired with one outside the container
 * (its iflink is the other end's index). With the host's network it sees the host's own interfaces, which link to
 * themselves.
 */
export function detectHostNetwork(sysNet = '/sys/class/net') {
  try {
    return fs.readdirSync(sysNet).some((name) => {
      if (name === 'lo') return false;
      const read = (file) => fs.readFileSync(path.join(sysNet, name, file), 'utf8').trim();
      return read('ifindex') === read('iflink');
    });
  } catch {
    return false;
  }
}

/** Whether this machine's own addresses are ones the home network can reach (not a container's private ones). */
export const addressesReachable = () => !inContainer() || hostNetwork();

// Windows and macOS file systems are case-insensitive by default; Linux is not.
const caseInsensitive = isWindows || isMac;

/** True when `child` is `root` itself or lies inside it. Works for drive roots like "E:\" and "/". */
export function isPathInside(child, root) {
  const rel = path.relative(caseInsensitive ? root.toLowerCase() : root, caseInsensitive ? child.toLowerCase() : child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
