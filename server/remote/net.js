import os from 'node:os';
import { getSetting } from '../settings.js';
import { ipInCidr } from '../auth.js';

// Bridges that Docker, Podman, libvirt and LXC make for their containers and VMs, and Windows' own NAT switches for
// WSL and Hyper-V ("vEthernet (WSL)", "vEthernet (Default Switch)"): nothing at home reaches them. Other vEthernet
// adapters stay: a Hyper-V external switch is the computer's real home connection.
const VIRTUAL_BRIDGE = /^(docker\d+|br-[0-9a-f]{12}|veth|virbr\d+|cni|podman\d+|lxcbr\d+|lxdbr\d+|vEthernet \((WSL|Default Switch)\b)/;

/** IPv4 addresses of this machine's network adapters (excluding loopback and container bridges). */
export function lanAddresses() {
  const wgSubnet = getSetting('wireguard')?.subnet;
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_BRIDGE.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      out.push({ interface: name, address: a.address, wireguard: wgSubnet ? ipInCidr(a.address, wgSubnet) : false });
    }
  }
  return out;
}

let cachedIp = null;
let cachedAt = 0;

const IP_SERVICES = ['https://api.ipify.org', 'https://ipv4.icanhazip.com', 'https://ifconfig.me/ip'];

/** This network's public IPv4 address as seen from the internet. */
export async function publicIp({ force = false } = {}) {
  if (!force && cachedIp && Date.now() - cachedAt < 5 * 60 * 1000) return cachedIp;
  let lastErr;
  for (const url of IP_SERVICES) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'curl/8' } });
      if (!res.ok) throw new Error(`${url} -> ${res.status}`);
      const ip = (await res.text()).trim();
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error(`Unexpected answer from ${url}`);
      cachedIp = ip;
      cachedAt = Date.now();
      return ip;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`Could not determine public IP: ${lastErr?.message}`);
}

/** The last public IP we looked up (null until the first successful lookup). */
export const lastKnownPublicIp = () => cachedIp;

/** Carrier-grade NAT range: port forwarding can't work from behind it. */
export const isCgnat = (ip) => ipInCidr(ip, '100.64.0.0/10');
