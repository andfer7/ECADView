"""Exercise browser-launch failures without opening real browsers during tests."""

from types import SimpleNamespace
import subprocess
import unittest
from unittest.mock import Mock, call, patch
import webbrowser

from pcbvisualizer.cli import open_in_browser


URL = "http://127.0.0.1:8000/"


class BrowserLaunchTests(unittest.TestCase):
    def test_macos_uses_native_chrome_launch_without_applescript(self):
        with patch('pcbvisualizer.cli.sys.platform', 'darwin'), \
             patch('pcbvisualizer.cli.subprocess.run', return_value=SimpleNamespace(returncode=0)) as run, \
             patch('pcbvisualizer.cli.webbrowser.get') as get, \
             patch('pcbvisualizer.cli.webbrowser.open') as default:
            open_in_browser(URL)
        run.assert_called_once_with(['/usr/bin/open', '-a', 'Google Chrome', URL], timeout=10, check=False)
        get.assert_not_called()
        default.assert_not_called()

    def test_macos_default_and_named_browsers_use_native_open(self):
        for browser, arguments in (
            ('default', []), ('firefox', ['-a', 'Firefox']), ('safari', ['-a', 'Safari']),
            ('Google Chrome', ['-a', 'Google Chrome']),
        ):
            with self.subTest(browser=browser), patch('pcbvisualizer.cli.sys.platform', 'darwin'), \
                 patch('pcbvisualizer.cli.subprocess.run', return_value=SimpleNamespace(returncode=0)) as run:
                open_in_browser(URL, browser)
            run.assert_called_once_with(['/usr/bin/open', *arguments, URL], timeout=10, check=False)

    def test_macos_failed_chrome_launch_falls_back_to_native_default(self):
        for failure in (SimpleNamespace(returncode=1), OSError('missing command'),
                        subprocess.TimeoutExpired('open', 10)):
            with self.subTest(failure=failure), patch('pcbvisualizer.cli.sys.platform', 'darwin'), \
                 patch('pcbvisualizer.cli.subprocess.run', side_effect=[failure, SimpleNamespace(returncode=0)]) as run, \
                 patch('builtins.print'):
                open_in_browser(URL)
            self.assertEqual(run.call_args_list, [
                call(['/usr/bin/open', '-a', 'Google Chrome', URL], timeout=10, check=False),
                call(['/usr/bin/open', URL], timeout=10, check=False),
            ])

    def test_macos_failed_default_reports_manual_url(self):
        with patch('pcbvisualizer.cli.sys.platform', 'darwin'), \
             patch('pcbvisualizer.cli.subprocess.run', return_value=SimpleNamespace(returncode=1)) as run, \
             patch('builtins.print') as output:
            open_in_browser(URL, 'default')
        self.assertEqual(run.call_count, 1)
        output.assert_called_once_with(f'Could not open a browser automatically. Open this URL manually: {URL}')

    def test_false_return_from_controller_does_not_suppress_other_controllers(self):
        failed, working = Mock(), Mock()
        failed.open.return_value = False
        working.open.return_value = True
        with patch('pcbvisualizer.cli.sys.platform', 'linux'), \
             patch('pcbvisualizer.cli.webbrowser.get', side_effect=[failed, working]) as get, \
             patch('pcbvisualizer.cli.webbrowser.open') as default:
            open_in_browser(URL)
        self.assertEqual(get.call_args_list, [call('chrome'), call('chrome.exe')])
        failed.open.assert_called_once_with(URL)
        working.open.assert_called_once_with(URL)
        default.assert_not_called()

    def test_controller_errors_fall_back_to_default(self):
        for error in (webbrowser.Error('not found'), OSError('cannot launch')):
            with self.subTest(error=error), patch('pcbvisualizer.cli.sys.platform', 'linux'), \
                 patch('pcbvisualizer.cli.webbrowser.get', side_effect=error), \
                 patch('pcbvisualizer.cli.webbrowser.open', return_value=True) as default, \
                 patch('builtins.print'):
                open_in_browser(URL)
            default.assert_called_once_with(URL)

    def test_failed_default_controller_reports_manual_url(self):
        with patch('pcbvisualizer.cli.sys.platform', 'linux'), \
             patch('pcbvisualizer.cli.webbrowser.open', return_value=False), \
             patch('builtins.print') as output:
            open_in_browser(URL, 'default')
        output.assert_called_once_with(f'Could not open a browser automatically. Open this URL manually: {URL}')

    def test_windows_failed_executable_launch_keeps_the_fallback_available(self):
        with patch('pcbvisualizer.cli.sys.platform', 'win32'), \
             patch('pcbvisualizer.cli.webbrowser.get', side_effect=webbrowser.Error), \
             patch('pcbvisualizer.cli.Path.is_file', return_value=True), \
             patch('pcbvisualizer.cli.subprocess.Popen', side_effect=OSError('cannot launch')), \
             patch('pcbvisualizer.cli.webbrowser.open', return_value=True) as default, \
             patch('builtins.print'):
            open_in_browser(URL)
        default.assert_called_once_with(URL)
