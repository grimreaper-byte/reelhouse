# The live update stream against a small local server that behaves like Reelhouse's /api/events.
import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import helpers  # noqa: F401  (puts the add-on on sys.path)

from resources.lib.api import Api, ApiError


class Events(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    seen = []

    def do_GET(self):
        Events.seen.append({'path': self.path, 'auth': self.headers.get('Authorization'), 'accept': self.headers.get('Accept')})
        if self.headers.get('Authorization') != 'Bearer good':
            self.send_response(401)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        self.wfile.write(b'retry: 5000\nevent: hello\ndata: ' + json.dumps({'version': 7}).encode() + b'\n\n')
        self.wfile.write(b': ping\n\nevent: state\ndata: {"itemIds": [1, 2]}\n\n')
        self.wfile.flush()
        time.sleep(30)  # then nothing, like an idle stream between keep-alives

    def log_message(self, *args):
        pass


class EventStreamTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Events)
        cls.server.daemon_threads = True
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = 'http://127.0.0.1:{}'.format(cls.server.server_address[1])

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_reads_events_and_close_ends_a_blocked_read_at_once(self):
        stream = Api(self.url, 'good').events()
        got = []
        done = threading.Event()

        def read():
            for event in stream:
                got.append(event)
            done.set()

        threading.Thread(target=read, daemon=True).start()
        deadline = time.time() + 5
        while len(got) < 3 and time.time() < deadline:
            time.sleep(0.05)
        self.assertEqual(got, [('hello', {'version': 7}), ('ping', None), ('state', {'itemIds': [1, 2]})])
        self.assertFalse(done.wait(0.3), 'still waiting for the next event')

        started = time.time()
        stream.close()
        self.assertTrue(done.wait(2), 'close() should end the read')
        self.assertLess(time.time() - started, 1)
        self.assertEqual(Events.seen[-1], {'path': '/api/events', 'auth': 'Bearer good', 'accept': 'text/event-stream'})

    def test_refused_stream_reports_the_status(self):
        with self.assertRaises(ApiError) as ctx:
            Api(self.url, 'stale').events()
        self.assertEqual(ctx.exception.status, 401)

    def test_unreachable_server_is_an_api_error(self):
        with self.assertRaises(ApiError) as ctx:
            Api('http://127.0.0.1:9', 'good').events()
        self.assertIsNone(ctx.exception.status)

    def test_close_before_reading_is_harmless(self):
        stream = Api(self.url, 'good').events()
        stream.close()
        self.assertEqual(list(stream), [])


if __name__ == '__main__':
    unittest.main()
