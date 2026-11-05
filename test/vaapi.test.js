import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vaapiRateControlFrom } from '../server/media/ffmpeg.js';
import { vaapiQp, videoEncoderArgs } from '../server/transcode/hls.js';
import { qualityById } from '../server/transcode/profile.js';

const media = { bitrate: 6_000_000 };

test('a VAAPI driver that only does constant quality is recognised from ffmpeg\'s error', () => {
  // As a home server's Intel GPU reported it.
  const seen = '[h264_vaapi @ 0x563ce8ccfbc0] Driver does not support VBR RC mode (supported modes: CQP). | Error initializing output stream 0:0';
  assert.equal(vaapiRateControlFrom(seen), 'CQP');
  assert.equal(vaapiRateControlFrom('Driver does not support CBR RC mode (supported modes: CQP, VBR).'), 'VBR');
  assert.equal(vaapiRateControlFrom('Driver does not support ICQ RC mode (supported modes: AVBR).'), null);
  assert.equal(vaapiRateControlFrom('No VA display found for device /dev/dri/renderD128.'), null);
  assert.equal(vaapiRateControlFrom(undefined), null);
});

test('VAAPI converts at constant quality when the driver can\'t do bitrate control, else at a bitrate', () => {
  const cqp = videoEncoderArgs('h264_vaapi', qualityById('original'), media, { vaapiRateControl: 'CQP' });
  assert.deepEqual(cqp, ['-c:v', 'h264_vaapi', '-rc_mode', 'CQP', '-qp', '20', '-profile:v', 'high']);
  const low = videoEncoderArgs('h264_vaapi', qualityById('2m-720'), media, { vaapiRateControl: 'CQP' });
  assert.equal(low[low.indexOf('-qp') + 1], '26');
  assert.ok(!low.includes('-b:v') && !low.includes('-maxrate'));

  const vbr = videoEncoderArgs('h264_vaapi', qualityById('4m-720'), media, { vaapiRateControl: 'VBR' });
  assert.deepEqual(vbr.slice(0, 4), ['-c:v', 'h264_vaapi', '-rc_mode', 'VBR']);
  assert.equal(vbr[vbr.indexOf('-maxrate') + 1], '4000k');
  // Not detected yet (or another encoder's machine): bitrate control, as before.
  assert.ok(videoEncoderArgs('h264_vaapi', qualityById('4m-720'), media, null).includes('VBR'));
});

test('lower qualities get a higher QP (smaller files)', () => {
  const qps = ['original', '20m-1080', '8m-1080', '4m-720', '2m-720', '1500k-480', '720k-360'].map((id) => vaapiQp(qualityById(id)));
  assert.deepEqual(qps, [20, 21, 22, 24, 26, 28, 30]);
});
