"""Command-line startup and browser launching."""

import argparse
import base64
from http.server import ThreadingHTTPServer
from pathlib import Path
import subprocess
import sys
import threading
import webbrowser

try:
    from .rendering import render_file
    from .server import Handler
except ImportError:
    sys.exit("altium-monkey is not installed. Run:  pip install altium-monkey")


def open_in_browser(url: str, browser: str = "chrome") -> None:
    if sys.platform == "darwin":
        # Python's macOS controllers use AppleScript, which can fail or wait for
        # Automation permission. Launch Services opens URLs without scripting Chrome.
        app = {"chrome": "Google Chrome", "firefox": "Firefox", "safari": "Safari"}.get(browser.lower(), browser)

        def native_open(application: str | None = None) -> bool:
            command = ["/usr/bin/open"]
            if application:
                command.extend(["-a", application])
            try:
                return subprocess.run(command + [url], timeout=10, check=False).returncode == 0
            except (OSError, subprocess.TimeoutExpired):
                return False

        if browser == "default":
            opened = native_open()
        else:
            opened = native_open(app)
            if not opened:
                print(f"Could not open {browser}; trying the system default browser.")
                opened = native_open()
        if not opened:
            print(f"Could not open a browser automatically. Open this URL manually: {url}")
        return
    if browser == "default":
        if not webbrowser.open(url):
            print(f"Could not open a browser automatically. Open this URL manually: {url}")
        return
    for name in (browser, f"{browser}.exe", f"google-{browser}", f"{browser}-browser"):
        try:
            if webbrowser.get(name).open(url):
                return
        except (webbrowser.Error, OSError):
            pass
    if sys.platform == "win32" and browser == "chrome":
        for exe in (r"C:\Program Files\Google\Chrome\Application\chrome.exe",
                    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"):
            if Path(exe).is_file():
                try:
                    subprocess.Popen([exe, url])
                    return
                except OSError:
                    pass
    print(f"Could not find {browser}; opening with the system default browser instead.")
    if not webbrowser.open(url):
        print(f"Could not open a browser automatically. Open this URL manually: {url}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Standalone Altium PCB and schematic viewer")
    ap.add_argument("pcbdoc", nargs="?", type=Path, help="optional .PcbDoc or .SchDoc to load at startup")
    ap.add_argument("--port", type=int, default=0, help="port to listen on (default: random free port)")
    ap.add_argument("--browser", default="chrome", help="chrome (default), firefox, safari, default, ...")
    ap.add_argument("--no-open", action="store_true", help="don't open a browser, just print the URL")
    args = ap.parse_args()

    if args.pcbdoc:
        if not args.pcbdoc.is_file():
            sys.exit(f"File not found: {args.pcbdoc}")
        print(f"Loading {args.pcbdoc.name} ...")
        Handler.initial = {**render_file(args.pcbdoc),
                           "source": base64.b64encode(args.pcbdoc.read_bytes()).decode("ascii")}

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    print(f"PCB viewer running at {url}   (Ctrl+C to stop)")

    if not args.no_open:
        threading.Timer(0.3, open_in_browser, args=(url, args.browser)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
