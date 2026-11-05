// Docker with host networking (network_mode: host): the container's addresses are the host's, so pairing codes
// carry them and the remote access page treats them as real. On a network of its own, they're the container's.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-hostnet-'));
process.env.REELHOUSE_DATA = dataDir;
process.env.REELHOUSE_DOCKER = '1'; // as in the Docker image
const { openDb, closeDb, run } = await import('../server/db.js');
const { loadUser } = await import('../server/auth.js');
const { createPairing } = await import('../server/pairing.js');
const { lanAddresses } = await import('../server/remote/net.js');
const { detectHostNetwork, hostNetwork, addressesReachable } = await import('../server/lib/platform.js');

// What a Linux host running Docker shows with host networking: its own cards plus Docker's bridges.
const HOST_INTERFACES = {
  lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  eth0: [{ family: 'IPv4', address: '192.168.1.50', internal: false }],
  docker0: [{ family: 'IPv4', address: '172.17.0.1', internal: false }],
  'br-90c387b6bca5': [{ family: 'IPv4', address: '172.18.0.1', internal: false }],
  // Windows' own NAT switches for WSL and Hyper-V.
  'vEthernet (WSL)': [{ family: 'IPv4', address: '172.29.224.1', internal: false }],
  'vEthernet (Default Switch)': [{ family: 'IPv4', address: '172.20.48.1', internal: false }],
  virbr0: [{ family: 'IPv4', address: '192.168.122.1', internal: false }],
};
const realInterfaces = os.networkInterfaces;

before(() => {
  openDb(':memory:');
  run("INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (1, 'dave', 'x', 1, ?)", Date.now());
  os.networkInterfaces = () => HOST_INTERFACES;
});

after(() => {
  os.networkInterfaces = realInterfaces;
  delete process.env.REELHOUSE_HOST_NETWORK;
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** A fake /sys/class/net: { name: [ifindex, iflink] }. */
function sysNet(interfaces) {
  const dir = fs.mkdtempSync(path.join(dataDir, 'sys-'));
  for (const [name, [index, link]] of Object.entries(interfaces)) {
    fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, name, 'ifindex'), `${index}\n`);
    fs.writeFileSync(path.join(dir, name, 'iflink'), `${link}\n`);
  }
  return dir;
}

test('host networking is told apart by the interfaces: a container’s own are pairs with an end outside', () => {
  // Measured in Docker on WSL with this image (--network bridge and --network host).
  assert.equal(detectHostNetwork(sysNet({ lo: [1, 1], eth0: [2, 15] })), false);
  assert.equal(detectHostNetwork(sysNet({ lo: [1, 1], eth0: [2, 2], docker0: [4, 4], 'br-90c387b6bca5': [3, 3] })), true);
  assert.equal(detectHostNetwork(path.join(dataDir, 'no-such-dir')), false);
});

test('container bridges are never offered as home addresses', () => {
  assert.deepEqual(lanAddresses().map((a) => `${a.interface} ${a.address}`), ['eth0 192.168.1.50']);
});

test('a Hyper-V external switch is the computer’s real home connection, so it stays', () => {
  const hyperV = { 'vEthernet (External Switch)': [{ family: 'IPv4', address: '192.168.1.51', internal: false }], 'vEthernet (WSL)': HOST_INTERFACES['vEthernet (WSL)'] };
  os.networkInterfaces = () => hyperV;
  try {
    assert.deepEqual(lanAddresses().map((a) => a.address), ['192.168.1.51']);
  } finally {
    os.networkInterfaces = () => HOST_INTERFACES;
  }
});

test('with host networking, pairing codes carry the server’s home address; without, they can’t', async () => {
  const req = { headers: { host: 'localhost:8484' }, protocol: 'http' };
  process.env.REELHOUSE_HOST_NETWORK = '1';
  assert.equal(hostNetwork(), true);
  assert.equal(addressesReachable(), true);
  assert.deepEqual((await createPairing(loadUser(1), req)).urls, ['http://192.168.1.50:8484']);

  process.env.REELHOUSE_HOST_NETWORK = '0';
  assert.equal(addressesReachable(), false);
  assert.deepEqual((await createPairing(loadUser(1), req)).urls, []); // only the page's address would do, and that's localhost
});
