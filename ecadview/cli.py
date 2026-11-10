"""Launch the local browser viewer and its isolated geometry worker."""

import argparse
import base64
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import threading
import webbrowser

try:
    from .rendering import render_file
    from .server import Handler, ViewerServer
except ImportError:
    sys.exit("altium-monkey is not installed. Run:  pip install altium-monkey")


def open_in_browser(url: str, browser: str = "chrome") -> None:
    if browser == "default":
        webbrowser.open(url)
        return
    for name in (browser, f"{browser}.exe", f"google-{browser}", f"{browser}-browser"):
        try:
            webbrowser.get(name).open(url)
            return
        except webbrowser.Error:
            pass
    if sys.platform == "darwin":
        app = {"chrome": "Google Chrome", "firefox": "Firefox", "safari": "Safari"}.get(browser, browser)
        if subprocess.run(["open", "-a", app, url]).returncode == 0:
            return
    elif sys.platform == "win32" and browser == "chrome":
        for exe in (r"C:\Program Files\Google\Chrome\Application\chrome.exe",
                    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"):
            if Path(exe).is_file():
                subprocess.Popen([exe, url])
                return
    print(f"Could not find {browser}; opening with the system default browser instead.")
    webbrowser.open(url)


def load_initial_documents(paths: list[Path]) -> list[dict]:
    """Expand locally opened projects while rendering each document once."""
    from .variants import resolve_document

    projects, documents = [], {}
    def identity(path):
        info = path.stat()
        return info.st_dev, info.st_ino

    explicit = {identity(path) for path in paths if path.suffix.lower() != ".prjpcb"}
    seen_projects = set()
    for path in paths:
        if path.suffix.lower() != ".prjpcb":
            documents.setdefault(identity(path), {"path": path})
            continue
        if identity(path) in seen_projects:
            continue
        seen_projects.add(identity(path))
        print(f"Loading {path.name} ...")
        project = render_file(path, native=True)
        project["project_key"] = "local-project-" + hashlib.sha256(os.fsencode(os.path.normcase(str(path.resolve())))).hexdigest()
        project["project_label"] = str(path)
        project["source"] = base64.b64encode(path.read_bytes()).decode("ascii")
        projects.append(project)
        for name in project["documents"]:
            try:
                member = resolve_document(path, name)
            except (OSError, ValueError) as error:
                warning = f"Could not open project document {name}: {error}"
                project["warnings"].append(warning)
                print(f"Warning: {warning}")
                continue
            task = documents.setdefault(identity(member), {"path": member})
            task.setdefault("project", project)
            task.setdefault("project_path", name)
    initial = list(projects)
    for document_id, task in documents.items():
        path = task["path"]
        print(f"Loading {path.name} ...")
        try:
            data = {**render_file(path, native=True), "source": base64.b64encode(path.read_bytes()).decode("ascii"), "webgl": True}
        except Exception as error:
            if document_id in explicit or "project" not in task:
                raise
            warning = f"Could not render project document {task['project_path']}: {type(error).__name__}: {error}"
            task["project"]["warnings"].append(warning)
            print(f"Warning: {warning}")
            continue
        if "project" in task:
            data.update(project_name=task["project"]["name"], project_key=task["project"]["project_key"],
                        project_path=task["project_path"])
        initial.append(data)
    return initial


def main() -> None:
    if len(sys.argv) == 3 and sys.argv[1] == "--project-picker-worker":
        from .project_picker import worker
        worker(sys.argv[2])
        return
    if len(sys.argv) == 4 and sys.argv[1] == "--web-geometry-worker":
        from .web_geometry import worker
        worker(sys.argv[2], sys.argv[3])
        return
    ap = argparse.ArgumentParser(description="ECADView: local browser-based Altium and KiCad PCB and schematic viewer")
    ap.add_argument("documents", nargs="*", type=Path, help="Altium projects/documents or KiCad documents to open in tabs")
    ap.add_argument("--web", action="store_true", help="compatibility option; the browser viewer is now the default")
    ap.add_argument("--port", type=int, default=None, help="local server port (default: random free port)")
    ap.add_argument("--browser", default=None, help="browser to use: chrome (default), firefox, safari, default, ...")
    ap.add_argument("--no-open", action="store_true", help="run the local server without opening a browser")
    args = ap.parse_args()

    for path in args.documents:
        if not path.is_file():
            ap.error(f"File not found: {path}")
    Handler.initial = None
    initial = load_initial_documents(args.documents)
    if initial:
        Handler.initial = initial[0] if len(initial) == 1 else {"documents": initial}

    server = ViewerServer(("127.0.0.1", args.port or 0), Handler)
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    print(f"ECADView running at {url}   (Close the viewer or Ctrl+C to stop)")

    if not args.no_open:
        threading.Timer(0.3, open_in_browser, args=(url, args.browser or "chrome")).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
