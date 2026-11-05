// App-wide state shared between views.
export const state = {
  server: null, // { name, version, setupRequired, network }
  me: null, // { user, network, defaults }
  libraries: [],
};

export const isAdmin = () => !!state.me?.user?.isAdmin;

const PREFS_KEY = 'reelhouse.prefs';

export function getPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
  } catch {
    return {};
  }
}

export function setPrefs(patch) {
  const next = { ...getPrefs(), ...patch };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {
    // storage unavailable (private mode) — prefs just won't persist
  }
  return next;
}

/** Quality to request: the user's choice for this kind of network, else a sensible default. */
export function preferredQuality() {
  const local = state.me?.network?.local;
  const prefs = getPrefs();
  const saved = local ? prefs.qualityLocal : prefs.qualityRemote;
  return saved || (local ? 'original' : state.me?.defaults?.remoteQuality || '4m-720');
}

export function savePreferredQuality(id) {
  setPrefs(state.me?.network?.local ? { qualityLocal: id } : { qualityRemote: id });
}
