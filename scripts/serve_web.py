#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Rebuild and serve the direct Web Serial edition on loopback."""

import argparse
import errno
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import shutil
import subprocess
import sys

from export_web import ROOT, export


class BrowserAssets(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def port_number(value):
    try:
        port = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("Port must be an integer from 1 to 65535") from None
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("Port must be an integer from 1 to 65535")
    return port


def open_chrome(url):
    if sys.platform == "darwin":
        subprocess.run(["open", "-a", "Google Chrome", url], check=True,
                       capture_output=True, text=True, timeout=10)
        return
    if sys.platform == "win32":
        candidates = [Path(os.environ[name]) / "Google/Chrome/Application/chrome.exe"
                      for name in ("LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)")
                      if os.environ.get(name)]
        executable = next((str(path) for path in candidates if path.is_file()), None)
    else:
        executable = next((path for name in ("google-chrome", "google-chrome-stable",
                                             "chromium", "chromium-browser")
                           if (path := shutil.which(name))), None)
    if not executable:
        raise RuntimeError("Google Chrome was not found")
    subprocess.Popen([executable, url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=port_number, default=8769,
                        help="Local HTTP port (default: 8769)")
    parser.add_argument("--open", action="store_true", help="Open the synth in Google Chrome")
    args = parser.parse_args()
    url = f"http://127.0.0.1:{args.port}/"
    destination = ROOT / "dist" / "web"
    handler = partial(BrowserAssets, directory=str(destination))
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    except OSError as error:
        if error.errno == errno.EADDRINUSE:
            print(f"Cannot serve {url}: port {args.port} is already in use. "
                  "Stop the existing server or choose --port NUMBER.", file=sys.stderr)
        else:
            print(f"Cannot serve {url}: {error}", file=sys.stderr)
        return 1
    try:
        try:
            export(destination)
        except (OSError, ValueError) as error:
            print(f"Cannot rebuild the browser edition: {error}", file=sys.stderr)
            return 1
        print(f"Direct browser synth: {url}\n"
              "Current browser assets rebuilt. Keep this terminal open; Ctrl-C stops the server.",
              flush=True)
        if args.open:
            try:
                open_chrome(url)
            except (OSError, RuntimeError, subprocess.SubprocessError) as error:
                detail = getattr(error, "stderr", None) or str(error)
                print(f"Could not open Google Chrome: {detail.strip()}. "
                      f"The server is still running; open {url} in desktop Chrome or Edge.",
                      file=sys.stderr, flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nBrowser synth server stopped.", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
