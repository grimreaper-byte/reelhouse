// What this browser can play natively. Sent to the server so it can decide between direct play
// and transcoding.
let cached = null;

export function browserCaps() {
  if (cached) return cached;
  const v = document.createElement('video');
  const can = (type) => {
    try {
      return v.canPlayType(type) !== '';
    } catch {
      return false;
    }
  };
  const containers = ['mp4'];
  if (can('video/webm')) containers.push('webm');
  if (can('video/x-matroska') || can('video/mkv')) containers.push('mkv');

  const video = [];
  if (can('video/mp4; codecs="avc1.640028"')) video.push('h264');
  if (can('video/mp4; codecs="hvc1.1.6.L120.90"') || can('video/mp4; codecs="hev1.1.6.L120.90"')) video.push('hevc');
  if (can('video/mp4; codecs="hvc1.2.4.L120.90"') || can('video/mp4; codecs="hev1.2.4.L120.90"')) video.push('hevc10');
  if (can('video/webm; codecs="vp9"') || can('video/mp4; codecs="vp09.00.10.08"')) video.push('vp9');
  if (can('video/webm; codecs="vp8"')) video.push('vp8');
  if (can('video/mp4; codecs="av01.0.08M.08"')) video.push('av1');
  if (can('video/mp4; codecs="av01.0.08M.10"')) video.push('av1-10');

  const audio = [];
  if (can('audio/mp4; codecs="mp4a.40.2"')) audio.push('aac');
  if (can('audio/mpeg')) audio.push('mp3');
  if (can('audio/webm; codecs="opus"') || can('audio/mp4; codecs="opus"')) audio.push('opus');
  if (can('audio/webm; codecs="vorbis"')) audio.push('vorbis');
  if (can('audio/flac') || can('audio/mp4; codecs="flac"')) audio.push('flac');
  if (can('audio/mp4; codecs="ac-3"')) audio.push('ac3');
  if (can('audio/mp4; codecs="ec-3"')) audio.push('eac3');

  // Pictures the player can take copied as they are into converted (HLS) streams, when only the sound or the file
  // around the picture needs converting: hls.js moves them from MPEG-TS into MediaSource, so MediaSource must take
  // them (at 4K levels); Safari's own HLS player takes only H.264 in MPEG-TS.
  const mse = typeof window.MediaSource !== 'undefined' || typeof window.ManagedMediaSource !== 'undefined';
  const msePlays = (type) => {
    try {
      return !!(window.MediaSource || window.ManagedMediaSource)?.isTypeSupported(type);
    } catch {
      return false;
    }
  };
  const copyVideo = mse
    ? [
      msePlays('video/mp4; codecs="avc1.640033"') && 'h264',
      (msePlays('video/mp4; codecs="hvc1.1.6.L153.90"') || msePlays('video/mp4; codecs="hev1.1.6.L153.90"')) && 'hevc',
      (msePlays('video/mp4; codecs="hvc1.2.4.L153.90"') || msePlays('video/mp4; codecs="hev1.2.4.L153.90"')) && 'hevc10',
    ].filter((k) => k && video.includes(k))
    : can('application/vnd.apple.mpegurl') && video.includes('h264') ? ['h264'] : [];

  const chromium = !!navigator.userAgentData?.brands?.some((b) => b.brand === 'Chromium');
  cached = {
    containers,
    video,
    audio,
    copyVideo,
    // Chromium's MKV support is ffmpeg underneath, which undoes the header removal compression in
    // older MKVs. Other engines (Firefox) don't, and would play those files without a picture.
    mkvContentEncoding: chromium,
    // Firefox shows each frame at the time stamped on it, so an MKV's millisecond frame times judder when it plays
    // the file itself; the server copies such files into segments with even frame times instead. (Chromium is left
    // playing them as before.)
    stampedFrameTimes: !chromium,
    nativeHls: can('application/vnd.apple.mpegurl'),
    mse,
  };
  return cached;
}
