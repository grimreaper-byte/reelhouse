// Requests (see server/requests.js): the list, finding a film to ask for, asking, and removing.
import { Router } from 'express';
import { requireAdmin, requireUser } from '../auth.js';
import { tmdbConfigured } from '../metadata/tmdb.js';
import {
  addRequest, fulfilRequests, listRequests, removeAllRequests, removeRequest, requestLimit, requestsOn, searchFilms,
} from '../requests.js';

const router = Router();

// Off (no TMDB API key yet, or turned off by an admin in Settings → General): none of it answers, for anyone, and it
// says which. The requests are kept.
router.use('/requests', requireUser, (req, res, next) => {
  if (requestsOn()) return next();
  if (!tmdbConfigured()) {
    const error = 'Requests needs a TMDB API key, which an admin adds in Settings → Metadata';
    return res.status(403).json({ error, off: true, needsKey: true });
  }
  res.status(403).json({ error: 'Requests are turned off on this server', off: true });
});

const answer = (res, err) => {
  if (!err.status) throw err;
  res.status(err.status).json({ error: err.message, ...(err.itemId ? { itemId: err.itemId } : {}), ...(err.limit ? { limit: true } : {}) });
};

// { available: whether films can be asked for (TMDB is set up), requests: newest first, limit: { max, open } for
// this person, or null with no limit }
router.get('/requests', requireUser, (req, res) => {
  fulfilRequests(); // e.g. an admin matched a film to the right one by hand
  res.json({ available: tmdbConfigured(), requests: listRequests(req.user), limit: requestLimit(req.user) });
});

// Films to ask for: ?q=title (a trailing year narrows it down).
router.get('/requests/search', requireUser, async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 200);
  if (!q) return res.json({ results: [] });
  try {
    res.json({ results: await searchFilms(req.user, q) });
  } catch (err) {
    if (err.status) return answer(res, err);
    res.status(502).json({ error: `TMDB didn’t answer: ${err.message}` });
  }
});

// Ask for a film: { tmdbId }. 409 when it's on the server ({ itemId }) or already asked for.
router.post('/requests', requireUser, async (req, res) => {
  try {
    res.status(201).json({ request: await addRequest(req.user, Number(req.body?.tmdbId)) });
  } catch (err) {
    if (err.status) return answer(res, err);
    res.status(502).json({ error: `TMDB didn’t answer: ${err.message}` });
  }
});

// Remove one: your own, or any for an admin.
router.delete('/requests/:id', requireUser, (req, res) => {
  try {
    removeRequest(req.user, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    answer(res, err);
  }
});

// Remove them all (admins).
router.delete('/requests', requireAdmin, (req, res) => {
  res.json({ removed: removeAllRequests(req.user) });
});

export default router;
