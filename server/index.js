import './lib/privileges.js'; // must stay first: may switch away from root before any file is touched
import { ensureDirs } from './lib/paths.js';
import { openDb, closeDb, all } from './db.js';
import { getSetting, getSettings, settingsEvents, isSettingStored, updateSettings } from './settings.js';
import { pruneSessions } from './auth.js';
import { createApp } from './app.js';
import { startListeners, stopListeners, reloadCertificate, listenerStatus } from './listeners.js';
import { detectCapabilities } from './media/ffmpeg.js';
import { queueAllScans, onScanComplete, watchLibraries } from './scanner/index.js';
import { refreshLibrary } from './metadata/tmdb.js';
import { fulfilRequests } from './requests.js';
import { metadataProgress } from './events.js';
import { startTranscodeManager, stopAllSessions } from './transcode/hls.js';
import { startLiveManager, stopAllLiveSessions } from './transcode/live.js';
import { startDdns } from './remote/ddns.js';
import { startUpnp, removeUpnp } from './remote/upnp.js';
import { startCertRenewal, onCertChange } from './remote/tls.js';
import { writeServerConfigFile } from './remote/wireguard.js';
import { startAppTunnel, stopAppTunnel } from './remote/apptunnel.js';
import { lanAddresses } from './remote/net.js';
import { logger } from './lib/log.js';
import { COMMIT, VERSION } from './version.js';
import { regroupAllVersions } from './versions.js';

const log = logger('main');

ensureDirs();
openDb();
getSettings();
// Copies of one film shown as one (server/versions.js), straight away after an upgrade.
const regrouped = regroupAllVersions();
if (regrouped) log.info(`Copies of the same film: ${regrouped} items regrouped`);

const app = createApp();
await startListeners(app);
const listening = listenerStatus();
if (!listening.http?.listening) {
  log.error(`Could not start: ${listening.http?.error}. Change the port with the PORT environment variable.`);
}

startTranscodeManager();
startLiveManager();

detectCapabilities().then((caps) => {
  if (caps.error) {
    log.error('ffmpeg is required for scanning and transcoding:', caps.error);
    return;
  }
  const hw = Object.entries(caps.encoders).filter(([k, ok]) => ok && k !== 'libx264').map(([k]) => k);
  log.info(`${caps.ffmpeg}${hw.length ? ` · hardware encoders: ${hw.join(', ')}` : ''}`);
  // First run: use a working GPU encoder if there is one (the admin can change it later).
  if (hw.length && !isSettingStored('encoder')) {
    updateSettings({ encoder: hw[0] });
    log.info(`Using ${hw[0]} for transcoding`);
  }
  for (const f of caps.gpu?.findings || []) {
    if (f.level === 'warn') log.warn(`GPU: ${f.text}. ${f.hint || ''}`.trim());
  }
});

// Library scanning: once at startup, then on an interval and when files change.
// Requested films that have now turned up are taken off the list once their metadata (and TMDB id) is in.
onScanComplete(async (libraryId, progress) => {
  await refreshLibrary(libraryId, progress);
  fulfilRequests();
});
setTimeout(() => queueAllScans(), 3000);
watchLibraries(getSetting('watchFolders'));

let scanTimer = null;
function scheduleScans() {
  clearInterval(scanTimer);
  const minutes = Number(getSetting('scanIntervalMinutes'));
  if (minutes > 0) {
    scanTimer = setInterval(() => queueAllScans(), minutes * 60 * 1000);
    scanTimer.unref();
  }
}
scheduleScans();

settingsEvents.on('change', (changed) => {
  if ('scanIntervalMinutes' in changed) scheduleScans();
  if ('watchFolders' in changed) watchLibraries(getSetting('watchFolders'));
  if ('tmdbApiKey' in changed && getSetting('tmdbApiKey')) {
    for (const lib of all('SELECT id FROM libraries')) void refreshLibrary(lib.id, metadataProgress(lib.id));
  }
});

// Remote access.
startDdns();
if (getSetting('upnp').enabled) startUpnp();
onCertChange(() => void reloadCertificate());
startCertRenewal();
writeServerConfigFile();
startAppTunnel(getSetting('port'));

setInterval(pruneSessions, 6 * 3600 * 1000).unref();

const port = getSetting('port');
log.info(`Reelhouse ${VERSION}${COMMIT ? ` (build ${COMMIT})` : ''} is running`);
log.info(`  This computer:  http://localhost:${port}`);
for (const a of lanAddresses()) log.info(`  ${a.wireguard ? 'WireGuard:     ' : 'Your network:  '} http://${a.address}:${port}`);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Shutting down (${signal})`);
  stopAllSessions();
  stopAllLiveSessions();
  stopAppTunnel();
  await Promise.race([removeUpnp(), new Promise((r) => setTimeout(r, 3000))]);
  await stopListeners();
  closeDb();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log.error('Unhandled promise rejection:', err));
