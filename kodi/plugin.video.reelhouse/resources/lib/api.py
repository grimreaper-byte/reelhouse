# Talks to a Reelhouse server: device sign-in, the sync API, playback and watch-state reporting.
import io
import json
import select
import socket
import threading
from http.client import HTTPConnection, HTTPException, HTTPSConnection
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import Request, urlopen

USER_AGENT = 'Reelhouse-Kodi/0.2.0'
TOKEN_PARAM = 'X-Reelhouse-Token'

# Kodi plays nearly everything itself, so it asks Reelhouse for the original file, never a conversion.
PLAYS_EVERYTHING = {
    'containers': ['mp4', 'mkv', 'webm', 'avi', 'ts', 'mpeg', 'asf', 'flv', 'ogg', 'mov', 'm2ts', 'wmv'],
    'video': ['h264', 'h264-hi', 'hevc', 'hevc10', 'av1', 'av1-10', 'vp9', 'vp8', 'mpeg2video', 'mpeg4', 'vc1', 'msmpeg4v3'],
    'audio': ['aac', 'mp3', 'ac3', 'eac3', 'dts', 'truehd', 'flac', 'opus', 'vorbis', 'pcm_s16le', 'pcm_s24le', 'mp2', 'alac'],
    'mse': True,
    'nativeHls': True,
    'mkvContentEncoding': True,
}


class ApiError(Exception):
    def __init__(self, message, status=None):
        Exception.__init__(self, message)
        self.status = status


def normalize_url(url):
    url = (url or '').strip().rstrip('/')
    if url and '://' not in url:
        url = 'http://' + url
    return url


class Api(object):
    def __init__(self, base_url, token=None, timeout=30):
        self.base_url = normalize_url(base_url)
        self.token = token
        self.timeout = timeout

    # ---------- plumbing ----------

    def headers(self, accept='application/json'):
        headers = {'User-Agent': USER_AGENT, 'Accept': accept, 'X-Requested-With': 'reelhouse'}
        if self.token:
            headers['Authorization'] = 'Bearer ' + self.token
        return headers

    def _request(self, method, path, body=None, timeout=None, stream=False):
        if not self.base_url:
            raise ApiError('No Reelhouse address set')
        headers = self.headers()
        data = None
        if body is not None:
            data = json.dumps(body).encode('utf-8')
            headers['Content-Type'] = 'application/json'
        req = Request(self.base_url + path, data=data, headers=headers, method=method)
        try:
            res = urlopen(req, timeout=timeout or self.timeout)
        except HTTPError as err:
            try:
                message = json.loads(err.read().decode('utf-8')).get('error') or err.reason
            except Exception:
                message = err.reason
            raise ApiError(str(message), err.code)
        except (URLError, socket.timeout, OSError) as err:
            reason = getattr(err, 'reason', err)
            raise ApiError('Reelhouse is not reachable at {} ({})'.format(self.base_url, reason))
        if stream:
            return res
        with res:
            raw = res.read()
        return json.loads(raw.decode('utf-8')) if raw else {}

    def get(self, path, **kw):
        return self._request('GET', path, **kw)

    def post(self, path, body=None, **kw):
        return self._request('POST', path, body if body is not None else {}, **kw)

    def media_url(self, path, **params):
        """Absolute URL for an image, stream or subtitle, carrying the token (Kodi fetches these itself)."""
        if not path:
            return None
        if self.token:
            params[TOKEN_PARAM] = self.token
        sep = '&' if '?' in path else '?'
        return self.base_url + path + (sep + urlencode(params) if params else '')

    # ---------- sign-in ----------

    @classmethod
    def sign_in(cls, base_url, username, password, device):
        api = cls(base_url)
        result = api.post('/api/auth/device', {'username': username, 'password': password, 'device': device})
        api.token = result['token']
        return api, result

    def sign_out(self):
        self.post('/api/auth/logout')

    # ---------- sync ----------

    def libraries(self):
        return self.get('/api/sync/libraries')

    def library_items(self, library_id):
        return self.get('/api/sync/libraries/{}/items'.format(int(library_id)), timeout=120)['items']

    def items(self, ids):
        return self.post('/api/sync/items', {'ids': list(ids)}, timeout=120)['items']

    def states(self, ids):
        return self.post('/api/sync/states', {'ids': list(ids)})['states']

    # ---------- playback ----------

    def playback(self, item_id):
        # "direct": Kodi always plays the original file, so Reelhouse must never start a conversion for it
        # (an older server ignores it and goes by the capabilities).
        return self.post('/api/playback/{}'.format(int(item_id)), {'direct': True, 'caps': PLAYS_EVERYTHING, 'quality': 'original'})

    def stream_url(self, item_id):
        return self.media_url('/api/stream/{}'.format(int(item_id)))

    def subtitle_url(self, item_id, track_id):
        return self.media_url('/api/subtitles/{}/{}.vtt'.format(int(item_id), quote(str(track_id))))

    def subtitle(self, item_id, track_id):
        """A sidecar subtitle track as WebVTT bytes."""
        path = '/api/subtitles/{}/{}.vtt'.format(int(item_id), quote(str(track_id)))
        with self._request('GET', path, timeout=30, stream=True) as res:
            return res.read()

    def report_progress(self, item_id, position, duration, state, play_id=None, timeout=10):
        return self.post('/api/progress', {
            'itemId': int(item_id), 'position': float(position or 0), 'duration': float(duration or 0),
            'state': state, 'playId': play_id, 'mode': 'direct', 'quality': 'original',
        }, timeout=timeout)

    def set_watched(self, item_id, watched, timeout=10):
        return self.post('/api/items/{}/watched'.format(int(item_id)), {'watched': bool(watched)}, timeout=timeout)

    # ---------- live updates ----------

    def events(self, timeout=90):
        """Opens Reelhouse's live update stream (see EventStream)."""
        return EventStream(self, timeout)

    def host(self):
        return urlsplit(self.base_url).netloc


class EventStream(object):
    """Reelhouse's live update stream: iterate it for (event, data) until the connection drops.

    close() ends it within a fraction of a second, from any thread. A plain blocking read would wait for
    the server's next keep-alive (25 seconds), longer than Kodi gives a service to stop, and no socket call
    wakes such a read from another thread on every platform. So reads wait in short slices instead.
    """

    def __init__(self, api, timeout):
        if not api.base_url:
            raise ApiError('No Reelhouse address set')
        self.stopped = threading.Event()
        parts = urlsplit(api.base_url)
        connection = HTTPSConnection if parts.scheme == 'https' else HTTPConnection
        self.conn = connection(parts.hostname, parts.port, timeout=timeout)
        try:
            self.conn.connect()
            self.conn.sock = _StoppableSocket(self.conn.sock, self.stopped, timeout)
            self.conn.request('GET', parts.path + '/api/events', headers=api.headers('text/event-stream'))
            self.res = self.conn.getresponse()
        except (HTTPException, OSError) as err:
            self.conn.close()
            raise ApiError('Reelhouse is not reachable at {} ({})'.format(api.base_url, err))
        if self.res.status != 200:
            self.conn.close()
            raise ApiError('Live updates refused ({})'.format(self.res.status), self.res.status)

    def __iter__(self):
        event, data = 'message', []
        try:
            for raw in self.res:
                if self.stopped.is_set():
                    return
                line = raw.decode('utf-8').rstrip('\r\n')
                if not line:
                    if data:
                        try:
                            yield event, json.loads('\n'.join(data))
                        except ValueError:
                            pass
                    event, data = 'message', []
                elif line.startswith(':'):
                    yield 'ping', None
                elif line.startswith('event:'):
                    event = line[6:].strip()
                elif line.startswith('data:'):
                    data.append(line[5:].strip())
        except (HTTPException, OSError, ValueError):
            pass  # closed, dropped or timed out: the caller reconnects
        finally:
            self.conn.close()

    def close(self):
        self.stopped.set()


class _StoppableSocket(object):
    """Stands in for an HTTP connection's socket: sends go straight through, reads stop once `stopped` is set.

    Like a real socket, it stays open until both it and the readers made from it are closed (http.client
    closes the connection right after the headers when the response runs until the connection ends).
    """

    def __init__(self, sock, stopped, timeout):
        self.sock = sock
        self.stopped = stopped
        self.timeout = timeout
        self.readers = 0
        self.closed = False

    def sendall(self, data):
        self.sock.sendall(data)

    def makefile(self, mode='rb', *args, **kwargs):
        self.readers += 1
        return io.BufferedReader(_StoppableReader(self))

    def close(self):
        self.closed = True
        self.release()

    def release(self):
        if self.closed and not self.readers:
            self.sock.close()


class _StoppableReader(io.RawIOBase):
    POLL = 0.25  # seconds between checks for close()

    def __init__(self, owner):
        io.RawIOBase.__init__(self)
        self.owner = owner

    def readable(self):
        return True

    def close(self):
        if not self.closed:
            self.owner.readers -= 1
            self.owner.release()
        io.RawIOBase.close(self)

    def readinto(self, buf):
        sock, waited = self.owner.sock, 0.0
        while not self.owner.stopped.is_set():
            # An SSL socket may hold decrypted data that select() can't see.
            if (hasattr(sock, 'pending') and sock.pending()) or select.select([sock], [], [], self.POLL)[0]:
                return sock.recv_into(buf)
            waited += self.POLL
            if self.owner.timeout and waited >= self.owner.timeout:
                raise socket.timeout('no data from Reelhouse for {} seconds'.format(self.owner.timeout))
        return 0  # closed: reads as the end of the stream


