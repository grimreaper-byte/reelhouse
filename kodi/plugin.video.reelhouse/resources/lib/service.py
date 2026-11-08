# The background service: the only writer of Kodi's database for this add-on. It syncs at start-up, on a timer
# and when Reelhouse announces changes (live event stream), reports playback progress, and passes watched marks
# made in Kodi back to Reelhouse.
import json
import queue
import re
import threading
import time
import traceback

import xbmc
import xbmcgui

from . import connection, live_overlay, utils
from .api import Api, ApiError
from .kodidb import KodiDbError
from .sync import SyncAborted, Syncer
from .syncdb import SyncDb
from .utils import string

REPORT_EVERY = 10   # seconds between progress reports while playing (and live TV heartbeats)
LIVE_RETRY = 15     # seconds before reconnecting the live event stream
GREET_RETRY = 5     # seconds before asking again (5, 10, then every LIVE_RETRY) when Reelhouse is out of reach at start-up
SETTLE = 2          # seconds to gather a burst of live events into one sync
UNSENT_MAX = 500    # updates kept while Reelhouse is unreachable


def compact(jobs):
    """Drops "playing" reports that a later report for the same item supersedes, and keeps the newest UNSENT_MAX."""
    out = []
    for kind, args in jobs:
        last = out[-1] if out else None
        if kind == 'progress' and last and last[0] == 'progress' and last[1][0] == args[0] and last[1][3] == 'playing':
            out[-1] = (kind, args)
        else:
            out.append((kind, args))
    return out[-UNSENT_MAX:]


def stream_id(playing):
    """The Reelhouse item a stream's URL is for, or None for anything else."""
    match = re.search(r'/api/stream/(\d+)(?:[/?#]|$)', playing)
    return int(match.group(1)) if match else None


class Player(xbmc.Player):
    def __init__(self, service, overlay=None):
        xbmc.Player.__init__(self)
        self.service = service
        self.overlay = overlay or live_overlay.Overlay()  # the logo and time left over Kodi's controls
        self.asked_now = 0.0
        self.current = None
        self.live = None        # a live TV session playing: {'playId', 'channel'}
        self.position = 0.0
        self.last_report = 0.0

    def leave(self):
        """What was playing is over: Reelhouse hears it now, rather than wondering where its player went."""
        self.report('stopped')
        self.current = None
        self.report_live('stopped')  # frees the tuner straight away

    def onPlayBackStarted(self):
        # Moving on in a playlist (the remote's Next and Previous), this is all Kodi says: never that the item it left
        # has stopped.
        self.leave()

    def onAVStarted(self):
        window = xbmcgui.Window(utils.HOME)
        raw = window.getProperty(utils.PLAYING_PROPERTY)
        try:
            info = json.loads(raw) if raw else None
            playing = self.getPlayingFile()
        except (ValueError, RuntimeError):
            info, playing = None, ''
        self.live = None
        # Only the stream the add-on just handed out (a leftover property must not claim some other video). One for
        # another item stays: skipping quickly, it's the next stream's, and this one is about to make way for it.
        if info and stream_id(playing) == int(info['id']):
            window.clearProperty(utils.PLAYING_PROPERTY)
            self.current = info
            if info.get('start'):
                self.seekTime(float(info['start']))  # the Reelhouse screens' Resume
                self.position = float(info['start'])
            else:
                self.position = self._time()
            self.report('playing')
        else:
            self.current = None
            self.start_live(playing)

    def start_live(self, playing):
        match = re.search(r'/api/live/([^/?#]+)/', playing)
        if not match:
            return
        try:
            info = json.loads(xbmcgui.Window(utils.HOME).getProperty(utils.LIVE_PROPERTY) or '{}')
        except ValueError:
            return
        if info.get('playId') == match.group(1):
            self.live = info
            self.report_live('playing')
            if not info.get('radio'):
                self.overlay.show(info.get('logo'), info.get('stop'))

    def report_live(self, state):
        live = self.live
        if not live:
            return
        self.last_report = time.time()
        self.service.send('live', live['playId'], state)
        if state == 'stopped':
            self.overlay.close()
            window = xbmcgui.Window(utils.HOME)
            try:
                if json.loads(window.getProperty(utils.LIVE_PROPERTY) or '{}').get('playId') == live['playId']:
                    window.clearProperty(utils.LIVE_PROPERTY)
            except ValueError:
                pass
            self.live = None

    def onPlayBackPaused(self):
        self.report('paused')
        self.report_live('paused')

    def onPlayBackResumed(self):
        self.report('playing')
        self.report_live('playing')

    def onPlayBackSeek(self, seek_time, offset):
        self.position = seek_time / 1000.0

    def onPlayBackStopped(self):
        self.leave()

    def onPlayBackEnded(self):
        if self.current:
            self.position = self.current.get('duration') or self.position
        self.report('ended')
        self.current = None
        self.report_live('stopped')

    def onPlayBackError(self):
        self.current = None
        self.report_live('stopped')

    def _time(self):
        try:
            return self.getTime()
        except RuntimeError:
            return self.position

    def tick(self):
        if self.live:
            if time.time() - self.last_report >= REPORT_EVERY:
                self.report_live('paused' if xbmc.getCondVisibility('Player.Paused') else 'playing')
            self.follow_programme()
            return
        if not self.current:
            return
        try:
            # Not while Kodi has moved on and hasn't said so yet: this would be the next item's time.
            if not self.isPlayingVideo() or stream_id(self.getPlayingFile()) != int(self.current['id']):
                return
            self.position = self.getTime()
            total = self.getTotalTime()
            if total:
                self.current['duration'] = total
        except RuntimeError:
            return
        if time.time() - self.last_report >= REPORT_EVERY and not xbmc.getCondVisibility('Player.Paused'):
            self.report('playing')

    def follow_programme(self):
        """The overlay's time left, and once the programme ends, what's on now (asked at most every 30 s)."""
        self.overlay.update()
        live = self.live
        if not live or not self.overlay.ended() or time.time() - self.asked_now < 30:
            return
        self.asked_now = time.time()
        try:
            now = (connection.api().get('/api/livetv/channels/{}/now'.format(live.get('uuid'))) or {}).get('now') or {}
        except (ApiError, OSError, ValueError):
            return
        if self.live is live and now.get('stop'):
            self.overlay.programme(now['stop'])

    def report(self, state):
        current = self.current
        if not current:
            return
        self.last_report = time.time()
        self.service.send('progress', current['id'], self.position, current.get('duration'), state, current.get('playId'))


class Service(xbmc.Monitor):
    def __init__(self):
        xbmc.Monitor.__init__(self)
        self.player = Player(self)
        self.jobs_lock = threading.Lock()
        self.wake = threading.Event()
        self.pending_sync = None        # None, 'all' or a set of library ids
        self.pending_states = set()
        self.pending_remove = False
        self.user_requested = False
        self.last_full = 0.0
        self.live_generation = 0
        self.live_stream = None
        self.rejected = False
        self.out_of_date = False        # a sync failed for lack of a connection: sync once Reelhouse is back
        self.outbox = queue.Queue()     # progress reports and watched marks, sent in order by one thread
        self.unsent = []                # ones that couldn't be sent while Reelhouse was unreachable
        self.unsent_lock = threading.Lock()

    # ---------- main loop ----------

    def run(self):
        utils.log('service started')
        for target in (self.worker, self.sender):
            thread = threading.Thread(target=target)
            thread.daemon = True
            thread.start()
        self.restart_live()
        if utils.signed_in():
            thread = threading.Thread(target=self.greet)
            thread.daemon = True
            thread.start()
        if utils.signed_in() and utils.setting_bool('open_on_start'):
            thread = threading.Thread(target=self.open_ui_when_ready)
            thread.daemon = True
            thread.start()
        if utils.signed_in() and utils.setting_bool('sync_startup'):
            self.request_sync()
        else:
            self.last_full = time.time()
        while not self.waitForAbort(1):
            self.player.tick()
            interval = utils.setting_int('sync_interval', 60)
            if interval and utils.signed_in() and not self.rejected and time.time() - self.last_full > interval * 60:
                self.request_sync()
        # Kodi gives a stopping service 5 seconds before killing it: wake the worker and end the live stream.
        self.wake.set()
        self.close_live()
        utils.log('service stopped')

    def greet(self):
        """Shows who this Kodi is signed in as once Reelhouse answers after Kodi starts (the network may still be
        coming up, or Reelhouse be off: it keeps asking until it answers)."""
        attempt = 0
        while utils.signed_in() and not self.rejected:
            try:
                api = connection.api()
                user = (api.get('/api/me', timeout=10) or {}).get('user') or {}
            except ApiError as err:
                if err.status == 401:
                    self.on_rejected()
                    return
                if err.status is not None and err.status < 500:
                    utils.log('start-up check failed: {}'.format(err), xbmc.LOGWARNING)
                    return
            else:
                name = user.get('username') or utils.setting('user_name')
                if name != utils.setting('user_name'):
                    utils.set_setting('user_name', name)  # renamed in Reelhouse since this Kodi signed in
                utils.notify(string(30121) % (utils.setting('server_name') or api.host(), name))
                return
            attempt += 1
            if self.waitForAbort(min(GREET_RETRY * attempt, LIVE_RETRY)):
                return

    def open_ui_when_ready(self):
        """Opens the Reelhouse screens once Kodi's home screen is up (the start-up setting)."""
        for _ in range(120):
            if xbmc.getCondVisibility('Window.IsActive(home) + !System.HasActiveModalDialog'):
                utils.open_ui()
                return
            if self.waitForAbort(0.5):
                return

    # ---------- requests from Kodi, the plugin and the live stream ----------

    def onNotification(self, sender, method, data):
        if sender == utils.ADDON_ID:
            action = method.split('.')[-1]
            if action == 'sync':
                self.request_sync(user=True)
            elif action == 'signedin':
                self.rejected = False
                self.restart_live()
                self.request_sync(user=True)
            elif action == 'signedout':
                self.restart_live()
            elif action == 'remove':
                with self.jobs_lock:
                    self.pending_remove = True
                    self.pending_sync = None
                self.wake.set()
        elif method == 'VideoLibrary.OnUpdate':
            self.on_library_update(data)

    def onSettingsChanged(self):
        self.rejected = False

    def request_sync(self, library_id=None, user=False):
        with self.jobs_lock:
            if library_id is None:
                self.pending_sync = 'all'
            elif self.pending_sync != 'all':
                self.pending_sync = (self.pending_sync or set()) | {library_id}
            self.user_requested = self.user_requested or user
        self.wake.set()

    def request_states(self, item_ids):
        with self.jobs_lock:
            self.pending_states.update(item_ids)
        self.wake.set()

    def on_library_update(self, data):
        # Watched / unwatched set in Kodi's own menus: tell Reelhouse. (The add-on's own writes don't notify.)
        try:
            info = json.loads(data)
        except ValueError:
            return
        if 'playcount' not in info or not isinstance(info.get('item'), dict):
            return
        kodi_type, kodi_id = info['item'].get('type'), info['item'].get('id')
        if kodi_type not in ('movie', 'episode') or kodi_id is None or not utils.signed_in():
            return
        records = SyncDb(connection.records_path())
        try:
            record = records.by_kodi(kodi_type, kodi_id)
        finally:
            records.close()
        if record:
            self.send('watched', record['id'], int(info['playcount'] or 0) > 0)

    # ---------- talking to Reelhouse ----------

    def send(self, kind, *args):
        """Queues a progress report ('progress') or a watched mark ('watched') for the sender thread."""
        self.outbox.put((kind, args))

    def sender(self):
        # One at a time and in order, so a later update (unwatched after watched, a stop after a heartbeat) never
        # overtakes an earlier one. Updates Reelhouse couldn't get go first once it answers again.
        while True:
            try:
                job = self.outbox.get(timeout=0.5)
            except queue.Empty:
                if self.abortRequested():
                    return
                continue
            with self.unsent_lock:
                jobs, self.unsent = self.unsent + ([job] if job else []), []
            for index, (kind, args) in enumerate(jobs):
                if not self.deliver(kind, args):
                    with self.unsent_lock:
                        self.unsent = compact(jobs[index:] + self.unsent)
                    if self.abortRequested():
                        return  # Kodi is closing and Reelhouse is out of reach: don't hold Kodi up
                    break

    def deliver(self, kind, args):
        """Sends one update. False when Reelhouse can't be reached (the update is kept for later)."""
        # While Kodi is shutting down there are only a few seconds left.
        timeout = 3 if self.abortRequested() else 10
        try:
            api = connection.api()
            if kind == 'progress':
                api.report_progress(*args, timeout=timeout)
            elif kind == 'live':
                api.post('/api/livetv/progress', {'playId': args[0], 'state': args[1]}, timeout=timeout)
            else:
                api.set_watched(*args, timeout=timeout)
        except ApiError as err:
            if kind == 'live':
                return True  # a heartbeat is only worth sending now; an ended session answers 404
            if err.status is None:
                if not self.unsent:
                    utils.log('Reelhouse is unreachable; keeping updates to send later ({})'.format(err), xbmc.LOGWARNING)
                return False
            if err.status == 401:
                self.on_rejected()
            utils.log('{} update failed: {}'.format(kind, err), xbmc.LOGWARNING)
        return True

    def on_rejected(self):
        if not self.rejected:
            self.rejected = True
            utils.log('Reelhouse rejected the sign-in; waiting for a new one', xbmc.LOGWARNING)
            utils.notify(string(30119), error=True, time_ms=10000)

    # ---------- the worker: one sync (or removal) at a time ----------

    def worker(self):
        while not self.abortRequested():
            self.wake.wait(5)
            self.wake.clear()
            if self.abortRequested():
                return
            with self.jobs_lock:
                user = self.user_requested
            if not user and self.waitForAbort(SETTLE):
                return
            with self.jobs_lock:
                job, states, remove, user = self.pending_sync, self.pending_states, self.pending_remove, self.user_requested
                self.pending_sync, self.pending_states, self.pending_remove, self.user_requested = None, set(), False, False
            if remove:
                self.run_job(self.remove_all, True)
            if job is not None:
                if job == 'all':
                    self.last_full = time.time()
                self.run_job(lambda syncer: self.sync(syncer, job, user), user)
            elif states:
                self.run_job(lambda syncer: syncer.apply_states(sorted(states)) and self.refresh_ui(), False)

    def run_job(self, job, user):
        if not utils.signed_in() and job != self.remove_all:
            return
        progress = None
        try:
            if user:
                progress = xbmcgui.DialogProgressBG()
                progress.create('Reelhouse', string(30113))
            with connection.open_all() as (api, kodi, records):
                syncer = Syncer(
                    api, kodi, records,
                    progress=(lambda pct, msg: progress.update(pct, 'Reelhouse', msg or string(30113))) if progress else None,
                    aborted=self.abortRequested,
                )
                job(syncer)
        except SyncAborted:
            pass
        except ApiError as err:
            if err.status == 401:
                self.on_rejected()
            else:
                if err.status is None:
                    self.out_of_date = True  # unreachable: synced again when the live stream reconnects
                utils.log('sync failed: {}'.format(err), xbmc.LOGWARNING)
                if user:
                    utils.notify(string(30115) % err, error=True)
        except KodiDbError as err:
            utils.log_error(str(err))
            utils.notify(string(30118) % err, error=True)
        except Exception as err:
            utils.log_error('sync failed: {}\n{}'.format(err, traceback.format_exc()))
            if user:
                utils.notify(string(30115) % err, error=True)
        finally:
            if progress:
                progress.close()

    def sync(self, syncer, job, user):
        if job == 'all':
            stats = syncer.run()
            self.out_of_date = False
        else:
            for library_id in sorted(job):
                stats = syncer.run(library_id)
        changes = stats['added'] + stats['updated'] + stats['removed'] + stats['states']
        utils.log('sync done: {}'.format(stats))
        if changes:
            self.refresh_ui()
        if user:
            utils.notify(string(30114) % (stats['added'], stats['updated'], stats['removed']))

    def remove_all(self, syncer):
        removed = syncer.remove_all()
        utils.log('removed {} items from Kodi'.format(removed))
        self.refresh_ui()
        utils.notify(string(30112) % removed)

    @staticmethod
    def refresh_ui():
        # Library lists re-read the database when refreshed; home-screen widgets reload with the window.
        if xbmc.getCondVisibility('Window.IsActive(videos) | Window.IsActive(home)'):
            xbmc.executebuiltin('Container.Refresh')

    # ---------- live updates ----------

    def restart_live(self):
        self.live_generation += 1
        self.close_live()
        thread = threading.Thread(target=self.live, args=(self.live_generation,))
        thread.daemon = True
        thread.start()

    @staticmethod
    def changed():
        """Tells open Reelhouse screens to re-read what they show."""
        xbmcgui.Window(utils.HOME).setProperty(utils.CHANGED_PROPERTY, repr(time.time()))

    def close_live(self):
        stream = self.live_stream
        if stream:
            stream.close()

    def live(self, generation):
        connected_before = False
        while not self.abortRequested() and generation == self.live_generation:
            if not utils.signed_in() or not utils.setting_bool('live_updates') or self.rejected:
                if self.waitForAbort(5):
                    return
                continue
            try:
                stream = Api(utils.setting('server_url'), utils.setting('device_token')).events()
                self.live_stream = stream
                if generation != self.live_generation:
                    stream.close()  # restarted while connecting
                for event, data in stream:
                    if self.abortRequested() or generation != self.live_generation:
                        return
                    if event == 'hello':
                        self.outbox.put(None)  # sends what couldn't be sent while Reelhouse was out of reach
                        # Back after a gap: new media and watched marks from other devices may have been missed.
                        # (A sync only fetches details for what changed, so this is cheap.)
                        if connected_before or self.out_of_date:
                            self.request_sync()
                            self.changed()
                        connected_before = True
                    elif event == 'library':
                        self.request_sync(None if data.get('deleted') else data.get('libraryId'))
                        self.changed()
                    elif event == 'state':
                        self.request_states(data.get('itemIds') or [])
                        self.changed()
                    elif event == 'livetv':
                        self.changed()  # e.g. channels in Continue Watching turned on or off
            except ApiError as err:
                if err.status == 401:
                    self.on_rejected()
            except Exception as err:
                utils.log('live updates: {}'.format(err), xbmc.LOGDEBUG)
            if self.waitForAbort(LIVE_RETRY):
                return


def run():
    Service().run()
