# Hardware transcoding (GPU) guide

Reelhouse converts video with ffmpeg whenever a device can't play a file as-is. A GPU makes that much faster and
lighter on the CPU. This guide shows how to make a GPU available on each kind of system.

**Contents:** [How it works](#how-it-works) · [Checking what Reelhouse sees](#checking-what-reelhouse-sees) ·
[Windows](#windows) · [Intel/AMD on Linux](#intel-or-amd-on-linux-vaapi) · [NVIDIA on Linux](#nvidia-on-linux) ·
[OpenMediaVault](#openmediavault) · [TrueNAS](#truenas) · [Proxmox](#proxmox-ve) · [WSL](#windows--docker-in-wsl) ·
[Troubleshooting](#troubleshooting)

## How it works

| GPU | Encoder | Where |
| --- | --- | --- |
| NVIDIA GeForce/Quadro/RTX | NVENC | Windows, Linux, Docker, WSL |
| Intel integrated graphics or Arc | Quick Sync (Windows), VAAPI (Linux) | Windows, Linux, Docker |
| AMD Radeon (integrated or discrete) | AMF (Windows), VAAPI (Linux) | Windows, Linux, Docker |

A GPU is driven by a **kernel driver on the host machine**. Containers share the host's kernel, so a Docker image
can't bring its own GPU driver. The host needs to:

1. have the GPU driver installed and working, and
2. pass the GPU into the container (a `devices:` line for Intel/AMD; the NVIDIA Container Toolkit for NVIDIA).

The Reelhouse image already contains everything else: an ffmpeg with NVENC, Quick Sync and VAAPI support, and the
Intel and AMD video drivers. On first start Reelhouse picks a working GPU encoder automatically.

**Which GPU is best for a media server?** Intel integrated graphics (Quick Sync) is the favourite: it uses little
power, handles several streams at once, and needs nothing extra installed on Linux. Consumer NVIDIA cards are fast,
but the driver limits how many streams they can encode at once (8 with current drivers). If that's exceeded, or a
GPU encoder fails, Reelhouse automatically moves that stream to the CPU.

**Raspberry Pi:** the Pi 5 has no hardware H.264 encoder, and the Pi 4's isn't supported, so conversion uses the CPU.
Direct play is unaffected.

**The GPU encodes; the processor decodes.** Reelhouse doesn't use the GPU to read the original yet, and HDR tone
mapping runs on the processor too. That's light for 1080p films, but converting a 4K 10-bit HEVC (HDR) film to a
lower quality takes a strong processor: on a 2-core laptop chip such as an Intel Core i7-6500U, decoding alone runs
at about real time, so the conversion falls behind and buffers. At **Original** such films play smoothly where only
their sound needs converting, as the picture is copied as it is. (When hardware decoding comes: Intel graphics
decode 10-bit HEVC from 7th-generation chips on; the i7-6500U's HD 520 does 8-bit only.)

## Checking what Reelhouse sees

Open **Settings → Transcoder → Hardware acceleration**. It shows:

- your processor, and whether it has integrated graphics;
- the GPUs Reelhouse can see, with driver versions;
- a status line for each encoder: *Working*, *Needs attention* (with the fix), or *Note*.

Click **Detect again** after changing drivers or container settings. In Docker, problems are also written to the log
at startup (`docker logs reelhouse`, lines starting with `GPU:`). For NVIDIA, `docker exec reelhouse nvidia-smi`
must list your card.

## Windows

Running Reelhouse directly on Windows (`npm start`) needs nothing special: install the latest driver from NVIDIA,
Intel or AMD, and NVENC, Quick Sync and AMF are used directly.

- **Integrated graphics not listed?** Many motherboards switch the processor's graphics off when a graphics card is
  installed. Turn it on in the BIOS/UEFI (look for *Integrated Graphics*, *iGPU* or *IGD Multi-Monitor*) to use
  Quick Sync alongside the card. Reelhouse says so when your processor has integrated graphics that Windows can't see.
- **Docker Desktop** passes NVIDIA GPUs to containers (WSL 2 backend, with the `deploy:` section in
  `docker-compose.yml`). It can't pass Intel or AMD GPUs. For Quick Sync or AMF on Windows, run Reelhouse natively.

## Intel or AMD on Linux (VAAPI)

This works the same on Debian, Ubuntu, OpenMediaVault, TrueNAS SCALE and in Proxmox, because the kernel already
includes the drivers (`i915`/`xe` for Intel, `amdgpu` for AMD).

1. On the host, check that a render device exists:

   ```bash
   ls -l /dev/dri
   ```

   You should see `renderD128`. If there's no `/dev/dri`, the GPU is disabled in the BIOS or its kernel driver
   isn't loaded.

2. **Docker:** pass the device into the container (already in `docker-compose.yml`, just uncomment it):

   ```yaml
   devices:
     - /dev/dri:/dev/dri
   ```

   When the container starts as root (the default), Reelhouse joins the device's group by itself. If you set
   `user:` in the compose file instead, add the device's group ID:

   ```yaml
   group_add:
     - "993"   # stat -c %g /dev/dri/renderD128
   ```

3. **Without Docker:** install the user-space driver and give the Reelhouse user access:

   ```bash
   sudo apt install intel-media-va-driver vainfo   # Intel, Broadwell (2014) and newer
   sudo apt install i965-va-driver vainfo          # older Intel
   sudo apt install mesa-va-drivers vainfo         # AMD
   sudo usermod -aG render reelhouse               # the user Reelhouse runs as
   ```

   `vainfo` should list H.264 encoding entries (`VAEntrypointEncSlice`).

4. In Reelhouse, choose **VAAPI** under Settings → Transcoder (picked automatically on first start if it works). With
   several GPUs, set **VAAPI device** to the right render node (`renderD129`, …).

> Very new Intel chips (Arc, Core Ultra) need a recent kernel and VA driver. If VAAPI fails on one of those, update
> the host kernel first.

## NVIDIA on Linux

These steps are for the **host**, or for a VM the GPU is passed through to.

1. **Install the driver.**
   - Ubuntu: `sudo ubuntu-drivers install`, then reboot.
   - Debian 12 / OpenMediaVault 7: add `contrib non-free non-free-firmware` to your APT sources, then
     `sudo apt install linux-headers-amd64 nvidia-driver firmware-misc-nonfree` and reboot. If you use the Proxmox
     kernel on OpenMediaVault, install `proxmox-default-headers` instead of `linux-headers-amd64`.
   - Check: `nvidia-smi` lists your card.

2. **Install the NVIDIA Container Toolkit** (only needed for Docker):

   ```bash
   curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
     | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
   curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
     | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
     | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
   sudo apt update && sudo apt install -y nvidia-container-toolkit
   sudo nvidia-ctk runtime configure --runtime=docker
   sudo systemctl restart docker
   ```

3. **Give the container the GPU.** Uncomment the NVIDIA section in `docker-compose.yml`:

   ```yaml
   deploy:
     resources:
       reservations:
         devices:
           - driver: nvidia
             count: all
             capabilities: [gpu, video, compute, utility]
   ```

   Alternatively, `runtime: nvidia` is enough, because the image already sets `NVIDIA_VISIBLE_DEVICES=all` and
   `NVIDIA_DRIVER_CAPABILITIES=compute,video,utility`. The `video` capability is what provides NVENC.

4. **Check:**

   ```bash
   docker run --rm --gpus all --entrypoint nvidia-smi reelhouse:latest
   ```

## OpenMediaVault

OpenMediaVault is Debian-based, so the Linux sections apply directly:

- **Intel/AMD:** add `/dev/dri:/dev/dri` under `devices:` in the compose file. That's all.
- **NVIDIA:** over SSH, follow [NVIDIA on Linux](#nvidia-on-linux) steps 1–2. Then add the compose file under
  *Services → Compose → Files* with the NVIDIA `deploy:` section.

Set `PUID`/`PGID` to the user that owns your shared folders, and map them read-only (`:ro`).

## TrueNAS

**TrueNAS SCALE / Community Edition** (Linux-based):

- **NVIDIA:** turn on NVIDIA driver installation in the Apps settings (*Apps → Configuration → Settings*). Then
  install Reelhouse as a custom app (*Discover Apps → Custom App*, or *Install via YAML* with the compose file) and
  include the NVIDIA `deploy:` section, or select the GPU in the app form.
- **Intel/AMD:** add `/dev/dri:/dev/dri` under `devices:` in the YAML.
- **Storage:** map a dataset to `/config` and your media datasets read-only. TrueNAS runs apps as the `apps` user
  (uid/gid 568) by default; set `PUID`/`PGID` to whatever owns your datasets.

**TrueNAS CORE / FreeNAS** (FreeBSD-based) can't run Docker, and NVIDIA's FreeBSD driver has no video encoder.
Reelhouse can run in a Linux VM (bhyve) using the CPU. GPU passthrough to bhyve VMs is unreliable. For hardware
transcoding, move to TrueNAS's Linux-based edition.

## Proxmox VE

Proxmox is a hypervisor: Reelhouse runs in a **VM** or an **LXC container** on it, and the GPU is handed to that.

### Option A: VM with PCIe passthrough (simplest for NVIDIA)

The GPU becomes dedicated to one VM.

1. Enable *VT-d* (Intel) or *AMD-Vi/IOMMU* (AMD) in the BIOS.
2. On Intel hosts, add `intel_iommu=on iommu=pt` to the kernel command line:
   - GRUB: edit `GRUB_CMDLINE_LINUX_DEFAULT` in `/etc/default/grub`, then run `update-grub`.
   - systemd-boot: edit `/etc/kernel/cmdline`, then run `proxmox-boot-tool refresh`.

   AMD hosts have IOMMU on by default.
3. Add `vfio`, `vfio_iommu_type1` and `vfio_pci` to `/etc/modules`, then reboot.
4. *VM → Hardware → Add → PCI Device*: pick the GPU and tick *All Functions*. Use the `q35` machine type and tick
   *PCI-Express*.
5. Inside the VM (Debian/Ubuntu), follow [NVIDIA on Linux](#nvidia-on-linux) or
   [Intel/AMD on Linux](#intel-or-amd-on-linux-vaapi), then run Docker as usual.

### Option B: LXC container (shares the GPU with the host)

Enable *Options → Features → Nesting* on the container so Docker can run inside it.

**Intel/AMD:**
- Proxmox VE 8.2 and later: *Container → Resources → Add → Device Passthrough*, path `/dev/dri/renderD128`. Set the
  GID to the `render` group inside the container (`getent group render`).
- Older versions: add these lines to `/etc/pve/lxc/<id>.conf`:

  ```
  lxc.cgroup2.devices.allow: c 226:* rwm
  lxc.mount.entry: /dev/dri dev/dri none bind,optional,create=dir
  ```

Then pass `/dev/dri` into the Reelhouse container as usual.

**NVIDIA** (more involved):
1. Install the NVIDIA driver on the Proxmox host (with `pve-headers`).
2. Inside the LXC, install the **exact same driver version** without its kernel module, e.g.
   `./NVIDIA-Linux-x86_64-<version>.run --no-kernel-module`.
3. Add the devices to `/etc/pve/lxc/<id>.conf`. Check the `nvidia-uvm` major number with `ls -l /dev/nvidia-uvm`.

   ```
   lxc.cgroup2.devices.allow: c 195:* rwm
   lxc.cgroup2.devices.allow: c <nvidia-uvm major>:* rwm
   lxc.mount.entry: /dev/nvidia0 dev/nvidia0 none bind,optional,create=file
   lxc.mount.entry: /dev/nvidiactl dev/nvidiactl none bind,optional,create=file
   lxc.mount.entry: /dev/nvidia-uvm dev/nvidia-uvm none bind,optional,create=file
   lxc.mount.entry: /dev/nvidia-uvm-tools dev/nvidia-uvm-tools none bind,optional,create=file
   ```

4. Inside the LXC, install the NVIDIA Container Toolkit (step 2 of [NVIDIA on Linux](#nvidia-on-linux)). For an
   *unprivileged* container, also set `no-cgroups = true` in `/etc/nvidia-container-runtime/config.toml`.
5. Whenever you update the host driver, update the LXC's driver to the same version.

## Windows + Docker in WSL

With Docker Engine installed inside WSL 2 (the setup in the README):

- **NVIDIA works.** WSL uses the normal Windows NVIDIA driver; install the NVIDIA Container Toolkit inside WSL
  ([NVIDIA on Linux](#nvidia-on-linux) step 2) and use the `deploy:` section. Don't install a Linux NVIDIA driver in WSL.
- **Intel/AMD VAAPI doesn't.** WSL exposes only a virtual GPU. Run Reelhouse directly on Windows for Quick Sync or AMF.

## Troubleshooting

| The Hardware acceleration panel says… | Fix |
| --- | --- |
| *No NVIDIA GPU is passed into this container* | Install the NVIDIA Container Toolkit on the host and add the `deploy:` section (or `runtime: nvidia`). |
| *An NVIDIA GPU is visible, but its video encoder library isn't* | The toolkit isn't injecting the driver libraries. Run `sudo nvidia-ctk runtime configure --runtime=docker`, restart Docker, and make sure the capabilities include `video`. |
| *An NVIDIA GPU was found, but NVENC failed* | Update the host driver. GeForce 600/700 (Kepler) and older cards aren't supported by current drivers. |
| *No Intel/AMD GPU (/dev/dri) is passed into this container* | Add `devices: - /dev/dri:/dev/dri`. |
| *Reelhouse isn't allowed to open /dev/dri/renderD128* | Start the container as root (the default), add `group_add` with the device's GID, or (no Docker) add the user to the `render` group. |
| *…has integrated graphics that this container can't see* | The host's processor has a GPU you aren't using; pass in `/dev/dri`. |
| *…has integrated graphics, but Windows doesn't show it* | Turn on integrated graphics in the BIOS/UEFI. |
| *A GPU is available, but VAAPI failed* | Update the host kernel. Without Docker, install the VA driver listed in the hint. |
| *VAAPI converts at constant quality on this GPU* | Nothing to fix: the driver can't do bitrate control, so conversions run at a fixed quality per setting (lower qualities still come out smaller). On Intel this usually means the GPU's HuC firmware isn't loaded; on many older chips the `i915.enable_guc=2` kernel option loads it (see your distribution's docs), after which Reelhouse uses bitrate control by itself. |
| *Converting with the CPU (libx264)* | Nothing is wrong: it's the fallback. Follow the section for your system to add a GPU. |

## What has been tested

- **Windows 10, native:** GeForce GTX 1050 Ti detected with its driver version, NVENC working. A processor without
  integrated graphics (Ryzen 5 3600) is identified, so there's no false "turn it on in the BIOS" hint.
- **Docker Engine 29.9 in WSL 2** with NVIDIA Container Toolkit 1.20.1, using `--gpus all`, the compose `deploy:`
  section, and plain `--runtime nvidia`: `nvidia-smi` and NVENC work inside the container as uid 1000, transcoding
  uses `h264_nvenc` with accurate seeking, and Reelhouse picks NVENC automatically on first start.
- **The same container without a GPU, and with WSL's `/dev/dri`:** the correct hints are shown.
- **GPU → CPU fallback** when NVENC rejects a stream (an 8192 px-wide video).
- **VAAPI on a real home server (Intel/AMD, Docker):** encoding works there, but its driver only does constant quality
  ("Driver does not support VBR RC mode (supported modes: CQP)"), which made every conversion fall back to the CPU.
  Reelhouse now checks for that at start-up (and when a conversion hits it) and converts with VAAPI at constant
  quality instead. The options were checked against the image's ffmpeg 5.1; the encode itself is still to be confirmed
  on that server.
- **Intel Core i7-6500U with HD 520 (Skylake) in Docker** (the user's test server, 22 October 2026): VAAPI encodes at
  constant quality; a 4K 10-bit HDR10 HEVC film with EAC3 sound plays smoothly in Firefox at Original (picture
  copied, sound converted) but buffers when converted to 1080p (decoded on the CPU).
- **Not yet tested on real hardware:** VAAPI with bitrate control, Proxmox, TrueNAS and OpenMediaVault.
