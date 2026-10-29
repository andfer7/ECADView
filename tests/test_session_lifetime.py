"""Viewer connections, reconnect grace and shutdown races."""
from http.client import HTTPConnection
import threading
import unittest

from pcbvisualizer.server import Handler, ViewerServer
from pcbvisualizer.session_lifetime import ViewerLifetime


class LifetimeTests(unittest.TestCase):
    def lifetime(self):
        stopped = threading.Event()
        lifetime = ViewerLifetime(stopped.set, grace=.08)
        self.addCleanup(lifetime.close)
        return lifetime, stopped

    def test_waits_for_first_viewer_then_stops_after_the_last_disconnect(self):
        lifetime, stopped = self.lifetime()
        self.assertFalse(stopped.wait(.12), "An unopened --no-open server stays available")
        connection = lifetime.connect()
        lifetime.disconnect(connection)
        self.assertTrue(stopped.wait(2))
        self.assertTrue(lifetime.stopping.is_set())
        self.assertIsNone(lifetime.connect(), "Shutdown cannot be revived by a late reconnect")

    def test_another_viewer_and_a_reload_both_cancel_pending_shutdown(self):
        lifetime, stopped = self.lifetime()
        first, second = lifetime.connect(), lifetime.connect()
        lifetime.disconnect(first)
        self.assertFalse(stopped.wait(.12))
        lifetime.disconnect(second)
        reload = lifetime.connect()
        self.assertFalse(stopped.wait(.12), "Reconnection cancels the old deadline")
        lifetime.disconnect(reload)
        self.assertTrue(stopped.wait(2))

    def test_explicit_close_cancels_the_monitor_and_is_idempotent(self):
        lifetime, stopped = self.lifetime()
        connection = lifetime.connect()
        lifetime.close()
        lifetime.disconnect(connection)
        lifetime.disconnect(connection)
        lifetime.close()
        self.assertIsNone(lifetime.connect())
        self.assertFalse(stopped.wait(.12), "Explicit Quit already owns shutdown")


class SessionEndpointTests(unittest.TestCase):
    def setUp(self):
        self.server = ViewerServer(("127.0.0.1", 0), Handler, grace=.12)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .02})
        self.thread.start()
        self.addCleanup(self.stop)

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        self.assertFalse(self.thread.is_alive())

    def stream(self, headers=None):
        connection = HTTPConnection(*self.server.server_address, timeout=3)
        connection.request("GET", "/session", headers=headers or {"Accept": "text/event-stream"})
        response = connection.getresponse()
        self.addCleanup(response.close)
        self.addCleanup(connection.close)
        return connection, response

    def test_real_stream_disconnect_stops_the_server_without_an_unload_request(self):
        connection, response = self.stream()
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader("Content-Type"), "text/event-stream")
        self.assertEqual(response.readline(), b"retry: 500\n")
        self.assertEqual(response.readline(), b"data: connected\n")
        self.assertFalse(self.server.viewer_lifetime.stopping.is_set())
        response.close()
        connection.close()
        self.thread.join(timeout=3)
        self.assertFalse(self.thread.is_alive())

    def test_cross_site_or_non_viewer_requests_do_not_create_sessions(self):
        for headers in ({"Accept": "text/event-stream", "Origin": "https://example.com"},
                        {"Accept": "text/event-stream", "Sec-Fetch-Site": "cross-site"},
                        {"Accept": "text/event-stream", "Host": "example.com"},
                        {"Accept": "text/html"}):
            with self.subTest(headers=headers):
                _, response = self.stream(headers)
                self.assertEqual(response.status, 403)
                response.read()
        self.assertFalse(self.server.viewer_lifetime.stopping.wait(.2))
        self.assertTrue(self.thread.is_alive())

    def test_server_close_releases_an_open_stream(self):
        _, response = self.stream()
        self.assertEqual(response.status, 200)
        self.server.shutdown()
        self.server.server_close()
        self.assertIn(b"connected", response.read())

    def test_binding_failure_preserves_the_original_socket_error(self):
        with self.assertRaises(OSError):
            ViewerServer(self.server.server_address, Handler)


if __name__ == "__main__":
    unittest.main()
