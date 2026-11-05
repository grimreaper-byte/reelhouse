// hls.js (the player for converted streams), loaded once when it's first needed: it's large.
let hlsModule = null;
export const loadHls = () => (hlsModule ||= import('/vendor/hls/hls.min.mjs').then((m) => m.default));
