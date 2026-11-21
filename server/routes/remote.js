// The phone as a remote (see server/remote.js): the devices it can control, sending one a command, and the devices'
// answers. The devices themselves listen on GET /api/events (?target=…).
import { Router } from 'express';
import { requireUser } from '../auth.js';
import { claim, commandDone, listTargets, reportControls, sendCommand } from '../remote.js';

const router = Router();

const answer = (res, err) => {
  if (!err.status) throw err;
  res.status(err.status).json({ error: err.message });
};

router.get('/remote/targets', requireUser, async (req, res) => {
  res.json({ targets: await listTargets(req) });
});

router.post('/remote/targets/:id/commands', requireUser, async (req, res) => {
  try {
    res.status(202).json({ commandId: await sendCommand(req, req.params.id, req.body || {}) });
  } catch (err) {
    answer(res, err);
  }
});

// A web tab took the focus: it becomes the one its browser is listed as.
router.post('/remote/targets/:id/claim', requireUser, (req, res) => {
  if (!claim(req, req.params.id)) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// A device says what it offers the phone (audio and subtitle tracks, volume, pausing), or that nothing plays.
router.post('/remote/status', requireUser, (req, res) => {
  if (!reportControls(req, req.body || {})) return res.status(404).json({ error: 'Not a device the phone can control' });
  res.json({ ok: true });
});

router.post('/remote/commands/:id/done', requireUser, (req, res) => {
  if (!commandDone(req, req.params.id, req.body || {})) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

export default router;
