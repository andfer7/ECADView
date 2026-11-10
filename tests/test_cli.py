"""The source, package and bundled entry point always launch the browser viewer."""
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from ecadview import cli

FIXTURE = Path(__file__).parent / 'fixtures/kicad/demo.kicad_pcb'

class BrowserLaunchTests(unittest.TestCase):
    def test_installed_console_command_points_to_the_renamed_package(self):
        from importlib.metadata import distribution

        commands = [entry for entry in distribution('ecadview').entry_points
                    if entry.group == 'console_scripts']
        self.assertEqual([(entry.name, entry.value) for entry in commands],
                         [('ecadview', 'ecadview.cli:main')])
        self.assertIs(commands[0].load(), cli.main)

    def launch(self, args):
        server = Mock()
        server.server_address = ('127.0.0.1', 12345)
        server.serve_forever.side_effect = KeyboardInterrupt
        with (patch.object(sys, 'argv', ['ecadview', *map(str, args)]),
              patch.object(cli, 'ViewerServer', return_value=server) as factory,
              patch.object(cli.threading, 'Timer') as timer,
              patch.object(cli, 'render_file', return_value={'name': FIXTURE.name, 'svg': '<svg/>'}) as render):
            cli.main()
        factory.assert_called_once_with(('127.0.0.1', 0 if '--port' not in args else 8000), cli.Handler)
        server.serve_forever.assert_called_once()
        server.server_close.assert_called_once()
        self.assertFalse(any(name.startswith('ecadview.desktop') for name in sys.modules))
        return timer, render

    def test_no_arguments_open_browser_and_an_empty_local_session(self):
        timer, render = self.launch([])
        timer.assert_called_once_with(0.3, cli.open_in_browser, args=('http://127.0.0.1:12345/', 'chrome'))
        timer.return_value.start.assert_called_once()
        render.assert_not_called()
        self.assertIsNone(cli.Handler.initial)

    def test_default_with_files_and_legacy_web_flag_share_the_same_launcher(self):
        for args in ([FIXTURE], ['--web', FIXTURE]):
            with self.subTest(args=args):
                timer, render = self.launch(args)
                timer.return_value.start.assert_called_once()
                render.assert_called_once_with(FIXTURE, native=True)
                self.assertEqual(cli.Handler.initial['name'], FIXTURE.name)
                self.assertTrue(cli.Handler.initial['webgl'])

    def test_no_open_and_explicit_browser_and_port_are_preserved(self):
        timer, _ = self.launch(['--no-open', '--port', 8000])
        timer.assert_not_called()
        timer, _ = self.launch(['--browser', 'default'])
        self.assertEqual(timer.call_args.kwargs['args'][1], 'default')

    def test_server_is_closed_when_serving_fails(self):
        server = Mock(server_address=('127.0.0.1', 12345))
        server.serve_forever.side_effect = RuntimeError('serving failed')
        with (patch.object(sys, 'argv', ['ecadview', '--no-open']),
              patch.object(cli, 'ViewerServer', return_value=server)):
            with self.assertRaisesRegex(RuntimeError, 'serving failed'):
                cli.main()
        server.server_close.assert_called_once()

    def test_geometry_worker_dispatch_never_starts_a_server_or_browser(self):
        with (patch.object(sys, 'argv', ['ECADView', '--web-geometry-worker', 'input.json', 'scene.bin']),
              patch('ecadview.web_geometry.worker') as worker,
              patch.object(cli, 'ViewerServer') as server,
              patch.object(cli.threading, 'Timer') as timer):
            cli.main()
        worker.assert_called_once_with('input.json', 'scene.bin')
        server.assert_not_called()
        timer.assert_not_called()

    def test_project_picker_worker_does_not_start_a_server_or_browser(self):
        for arguments in (['result.json'], ['result.json', 'électron board.PrjPcb']):
            with (self.subTest(arguments=arguments),
                  patch.object(sys, 'argv', ['ECADView', '--project-picker-worker', *arguments]),
                  patch('ecadview.project_picker.worker') as worker,
                  patch.object(cli, 'ViewerServer') as server,
                  patch.object(cli.threading, 'Timer') as timer):
                cli.main()
                worker.assert_called_once_with(*arguments)
                server.assert_not_called()
                timer.assert_not_called()

    def test_system_default_browser_is_opened(self):
        with patch.object(cli.webbrowser, 'open') as opened:
            cli.open_in_browser('http://127.0.0.1:12345/', 'default')
        opened.assert_called_once_with('http://127.0.0.1:12345/')

class DefaultEntryPointTests(unittest.TestCase):
    def test_default_script_and_module_open_browser_and_quit_the_local_backend(self):
        import json
        from http.client import HTTPConnection
        import subprocess
        import tempfile
        import time
        from urllib.parse import urlsplit
        root = Path(__file__).resolve().parents[1]
        for kind in ('script', 'module'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as tmp:
                record = Path(tmp) / 'browser-url.txt'
                invocation = (f'runpy.run_path({str(root / "ecadview.py")!r}, run_name="__main__")' if kind == 'script'
                              else 'runpy.run_module("ecadview", run_name="__main__")')
                bootstrap = f'''import runpy, sys, webbrowser
class RecordingBrowser:
    def open(self, url):
        with open({str(record)!r}, "w") as handle:
            handle.write(url)
        return True
webbrowser.register("chrome", None, RecordingBrowser())
sys.argv = ["ecadview"]
{invocation}
'''
                process = subprocess.Popen([sys.executable, '-B', '-c', bootstrap], cwd=root,
                                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                try:
                    deadline = time.monotonic() + 15
                    while not record.exists() and process.poll() is None and time.monotonic() < deadline:
                        time.sleep(.05)
                    self.assertTrue(record.exists(), 'The default entry point did not request a browser')
                    url = urlsplit(record.read_text())
                    connection = HTTPConnection(url.hostname, url.port, timeout=5)
                    try:
                        connection.request('GET', '/')
                        response = connection.getresponse()
                        self.assertEqual(response.status, 200)
                        self.assertIn(b'id="app"', response.read())
                        connection.request('POST', '/shutdown', b'',
                                           {'Origin': f'http://{url.netloc}', 'X-Viewer-Request': 'shutdown'})
                        response = connection.getresponse()
                        self.assertEqual(response.status, 200)
                        self.assertEqual(json.loads(response.read()), {'stopped': True})
                    finally:
                        connection.close()
                    self.assertEqual(process.wait(timeout=5), 0)
                finally:
                    if process.poll() is None:
                        process.terminate()
                        process.wait(timeout=5)
                    process.stderr.close()

if __name__ == '__main__':
    unittest.main()
