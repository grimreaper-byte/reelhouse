// Hardware-acceleration diagnostics: which GPUs this machine (or container) can see, whether the
// CPU has integrated graphics, and plain-language hints when an encoder that should work doesn't.
// Shown in Settings → Transcoder.
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { getSetting } from '../settings.js';
import { inContainer, isWindows, isLinux } from '../lib/platform.js';

const PCI_VENDORS = { '0x8086': 'Intel', '0x1002': 'AMD', '0x10de': 'NVIDIA' };
const LIB_DIRS = [
  '/usr/lib/x86_64-linux-gnu', '/usr/lib/aarch64-linux-gnu', '/usr/lib64', '/usr/lib',
  '/usr/lib/wsl/lib', '/usr/local/nvidia/lib64',
];
const ENCODER_LABELS = {
  h264_nvenc: 'NVIDIA NVENC',
  h264_qsv: 'Intel Quick Sync',
  h264_amf: 'AMD AMF',
  h264_vaapi: 'VAAPI hardware encoding',
};
const GUIDE = 'See docs/gpu.md for step-by-step setup.';

const exists = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};

const canOpen = (p) => {
  try {
    fs.accessSync(p, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

const readTrimmed = (p) => {
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    return null;
  }
};

function run(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 15000, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

const findLibrary = (name) => LIB_DIRS.map((dir) => `${dir}/${name}`).find(exists) || null;

function vendorFromName(name) {
  if (/nvidia|geforce|quadro|rtx|gtx/i.test(name)) return 'NVIDIA';
  if (/intel|iris|uhd graphics|arc/i.test(name)) return 'Intel';
  if (/amd|radeon/i.test(name)) return 'AMD';
  return null;
}

const cleanCpuName = (name) => name
  .replace(/\((R|TM)\)/gi, '')
  .replace(/\s+CPU\s+@.*$/i, '')
  .replace(/\s+\d+-Core Processor$/i, '')
  .replace(/\s+Processor$/i, '')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Whether a CPU model has integrated graphics: true, false, or null when we can't tell.
 * Intel: everything except "F"/"KF" models (Xeons mostly have none). AMD: APUs ("G" models,
 * "with Radeon Graphics") and Ryzen 7000+ desktop chips except "F" models.
 */
export function hasIntegratedGraphics(cpuName) {
  if (!cpuName) return null;
  const name = cleanCpuName(cpuName);
  if (/intel/i.test(name)) {
    if (/xeon/i.test(name)) return /\d{4}G\b/i.test(name) ? true : null;
    const model = name.match(/(?:i[3579]-|Ultra \d+ |Pentium |Celeron |\b)([A-Z]?\d{3,5})([A-Z]{0,3})\b/i);
    if (!model) return null;
    return !/F$/i.test(model[2]);
  }
  if (/amd/i.test(name)) {
    if (/radeon/i.test(name)) return true;
    if (/threadripper|epyc|opteron|fx-/i.test(name)) return false;
    const m = name.match(/Ryzen (?:AI )?\d+ (?:PRO )?(\d{4})([A-Z]*)/i);
    if (!m) return null;
    const [, num, suffix] = m;
    if (/G/i.test(suffix)) return true;
    if (/F/i.test(suffix)) return false;
    return Number(num) >= 7000;
  }
  return null;
}

/** /dev/dri render nodes (Intel/AMD GPUs on Linux) with their vendor and whether we may open them. */
function renderNodes() {
  let names;
  try {
    names = fs.readdirSync('/dev/dri').filter((n) => n.startsWith('renderD'));
  } catch {
    return [];
  }
  return names.map((name) => {
    const path = `/dev/dri/${name}`;
    let gid = null;
    try {
      gid = fs.statSync(path).gid;
    } catch {
      // keep null
    }
    return {
      path,
      vendor: PCI_VENDORS[readTrimmed(`/sys/class/drm/${name}/device/vendor`)] || null,
      accessible: canOpen(path),
      gid,
    };
  });
}

async function nvidiaGpus() {
  const out = await run('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader']);
  return out.split('\n').filter(Boolean).map((line) => {
    const [name, driver] = line.split(',').map((s) => s.trim());
    return { name, driver, vendor: 'NVIDIA' };
  });
}

/** Windows: graphics adapters and the CPU name in one PowerShell call. */
async function windowsHardware() {
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_VideoController | ForEach-Object { "GPU|" + $_.Name + "|" + $_.DriverVersion };'
    + ' Get-CimInstance Win32_Processor | Select-Object -First 1 | ForEach-Object { "CPU|" + $_.Name }']);
  const gpus = [];
  let cpu = null;
  for (const line of out.split(/\r?\n/)) {
    const [kind, name, driver] = line.split('|').map((s) => s?.trim());
    if (kind === 'CPU' && name) cpu = name;
    if (kind === 'GPU' && name) {
      const vendor = vendorFromName(name);
      // Skips "Microsoft Basic Display Adapter", remote-desktop adapters, etc.
      if (vendor) gpus.push({ name, driver: driver || null, vendor });
    }
  }
  return { gpus, cpu };
}

function linuxCpuName() {
  const info = readTrimmed('/proc/cpuinfo') || '';
  return info.match(/^model name\s*:\s*(.+)$/m)?.[1] || null;
}

const ffmpegSaid = (error) => (error ? `ffmpeg said: “${error}”. ` : '');

/**
 * @param caps  result of detectCapabilities(): { encoders: { id: bool }, encoderErrors: { id: string } }
 * @returns {
 *   cpu: { name, integratedGraphics: true|false|null },
 *   gpus: [{ name, vendor, driver }],
 *   findings: [{ level: 'ok'|'warn'|'info', text, hint }],
 * }
 */
export async function gpuDiagnostics(caps) {
  const enc = caps.encoders || {};
  const errors = caps.encoderErrors || {};
  const gpus = [];
  const findings = [];
  const add = (level, text, hint = null) => findings.push({ level, text, hint });
  const container = inContainer();
  const hwWorking = Object.keys(ENCODER_LABELS).filter((id) => enc[id]);
  let cpuName = null;

  if (isWindows) {
    const hw = await windowsHardware();
    gpus.push(...hw.gpus);
    cpuName = hw.cpu;
    const check = (vendor, id) => {
      if (!gpus.some((g) => g.vendor === vendor) || enc[id]) return;
      add('warn', `${ENCODER_LABELS[id]} isn’t working`, `${ffmpegSaid(errors[id])}Update the ${vendor} graphics driver, then click “Detect again”.`);
    };
    check('NVIDIA', 'h264_nvenc');
    check('Intel', 'h264_qsv');
    check('AMD', 'h264_amf');
  }

  let nodes = [];
  if (isLinux) {
    cpuName = linuxCpuName();
    // Containers share the host kernel, so this also spots Docker running inside WSL.
    const wsl = /microsoft/i.test(os.release());
    const nvidiaDevice = exists('/dev/nvidiactl') || exists('/dev/nvidia0');
    const nvidiaLib = findLibrary('libnvidia-encode.so.1');
    gpus.push(...(await nvidiaGpus()));
    nodes = renderNodes();
    for (const n of nodes) {
      if (n.vendor && n.vendor !== 'NVIDIA') gpus.push({ name: `${n.vendor} GPU (${n.path})`, vendor: n.vendor, driver: null });
    }

    // NVIDIA
    if (!enc.h264_nvenc && (nvidiaDevice || (wsl && nvidiaLib))) {
      if (!nvidiaLib) {
        add('warn', 'An NVIDIA GPU is visible, but its video encoder library (libnvidia-encode) isn’t',
          container
            ? 'The NVIDIA Container Toolkit isn’t active for this container. Install it on the host, run “sudo nvidia-ctk runtime configure --runtime=docker”, restart Docker, and give the container the GPU. ' + GUIDE
            : 'Install the full NVIDIA driver (it includes NVENC), then click “Detect again”.');
      } else {
        add('warn', 'An NVIDIA GPU was found, but NVENC failed',
          `${ffmpegSaid(errors.h264_nvenc)}Update the NVIDIA driver on the host. ${container ? 'Check that NVIDIA_DRIVER_CAPABILITIES includes “video”.' : ''}`.trim());
      }
    } else if (!enc.h264_nvenc && container) {
      add('info', 'No NVIDIA GPU is passed into this container', `Optional. ${GUIDE}`);
    }

    // Intel / AMD (integrated or discrete) via VAAPI
    const vaDevice = getSetting('vaapiDevice') || '/dev/dri/renderD128';
    const vaNodes = nodes.filter((n) => n.vendor !== 'NVIDIA');
    if (!enc.h264_vaapi && vaNodes.length) {
      const target = nodes.find((n) => n.path === vaDevice);
      if (!target) {
        add('warn', `The VAAPI device setting points to ${vaDevice}, which doesn’t exist`,
          `Available render devices: ${vaNodes.map((n) => n.path).join(', ')}. Change the VAAPI device below.`);
      } else if (!target.accessible) {
        add('warn', `Reelhouse isn’t allowed to open ${target.path}`,
          container
            ? `Start the container as root (the default) so it can join the device’s group, or add “group_add: ["${target.gid}"]” to the compose file.`
            : `Add the user running Reelhouse to the group that owns it (gid ${target.gid}, usually “render”): sudo usermod -aG render <user>, then restart Reelhouse.`);
      } else if (wsl && !target.vendor) {
        add('info', 'WSL’s virtual GPU doesn’t support VAAPI encoding', 'Use NVENC instead (NVIDIA), or run Reelhouse on Windows directly.');
      } else {
        const driver = target.vendor === 'Intel'
          ? 'Install intel-media-va-driver (Broadwell and newer) or i965-va-driver (older chips).'
          : target.vendor === 'AMD' ? 'Install mesa-va-drivers.' : 'Install the VA-API driver for this GPU.';
        add('warn', `${target.vendor ? `An ${target.vendor}` : 'A'} GPU is available, but VAAPI failed`,
          `${ffmpegSaid(errors.h264_vaapi)}${container ? 'The Docker image already includes the Intel and AMD drivers, so the host’s kernel driver may be missing or too old.' : driver}`);
      }
    } else if (enc.h264_vaapi && caps.vaapiRateControl === 'CQP') {
      add('info', 'VAAPI converts at constant quality on this GPU',
        'Its driver can’t do bitrate control (on Intel this usually means the GPU’s HuC firmware isn’t loaded). '
        + 'Conversions still use the GPU; lower qualities come out smaller, but their bitrates are approximate.');
    } else if (!enc.h264_vaapi && container && !wsl) {
      add('info', 'No Intel/AMD GPU (/dev/dri) is passed into this container',
        `Optional: add “devices: - /dev/dri:/dev/dri” to the compose file. ${GUIDE}`);
    }
  }

  // Integrated graphics the OS can't see — usually switched off in the BIOS when a graphics
  // card is installed, or not passed into a container.
  const igpu = hasIntegratedGraphics(cpuName);
  const cpuVendor = cpuName ? (/intel/i.test(cpuName) ? 'Intel' : /amd/i.test(cpuName) ? 'AMD' : null) : null;
  const igpuVisible = cpuVendor && gpus.some((g) => g.vendor === cpuVendor && !/arc|radeon rx|radeon pro/i.test(g.name));
  if (igpu && !igpuVisible && cpuVendor && !(isLinux && /microsoft/i.test(os.release()))) {
    const encoderName = cpuVendor === 'Intel' ? 'Quick Sync' : isWindows ? 'AMF' : 'VAAPI';
    const level = hwWorking.length ? 'info' : 'warn';
    if (container) {
      add(level, `The server’s ${cleanCpuName(cpuName)} has integrated graphics that this container can’t see`,
        `Pass it in with “devices: - /dev/dri:/dev/dri” to use ${encoderName}. ${GUIDE}`);
    } else {
      add(level, `Your ${cleanCpuName(cpuName)} has integrated graphics, but ${isWindows ? 'Windows' : 'the system'} doesn’t show it`,
        `It’s probably switched off in the BIOS/UEFI settings (look for “Integrated Graphics”, “iGPU” or “IGD Multi-Monitor”). `
        + `Turning it on lets Reelhouse use ${encoderName}${gpus.length ? ' alongside your graphics card' : ''}.`
        + (isLinux ? ' If it is on, check that the kernel driver (i915/xe for Intel, amdgpu for AMD) is loaded.' : ''));
    }
  }

  // Report every working encoder, even on chips we couldn't name.
  for (const id of hwWorking) add('ok', `${ENCODER_LABELS[id]} is working`);
  if (!hwWorking.length) {
    add('info', 'Converting with the CPU (libx264)', `This always works; a GPU makes conversions faster and frees up the CPU. ${GUIDE}`);
  }
  findings.sort((a, b) => ['ok', 'warn', 'info'].indexOf(a.level) - ['ok', 'warn', 'info'].indexOf(b.level));
  return {
    cpu: cpuName ? { name: cleanCpuName(cpuName), integratedGraphics: igpu } : null,
    gpus,
    findings,
  };
}
