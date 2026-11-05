// When started as root with PUID/PGID set (the Docker image does this), switch to that user
// before anything else runs, so every file the server creates belongs to that user. Also joins
// the groups that own /dev/dri/* so VAAPI hardware encoding keeps working.
// Imported first by server/index.js; ES modules evaluate imports in order.
import fs from 'node:fs';

if (typeof process.getuid === 'function' && process.getuid() === 0 && process.env.PUID) {
  const uid = Number(process.env.PUID);
  const gid = Number(process.env.PGID ?? process.env.PUID);
  if (Number.isInteger(uid) && Number.isInteger(gid) && uid !== 0) {
    const groups = new Set([gid]);
    try {
      for (const name of fs.readdirSync('/dev/dri')) groups.add(fs.statSync(`/dev/dri/${name}`).gid);
    } catch {
      // no GPU passed through
    }
    process.setgroups([...groups]);
    process.setgid(gid);
    process.setuid(uid);
  }
}
