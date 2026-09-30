# SPDX-License-Identifier: MPL-2.0
"""Loopback-only browser bridge. A development application, never a public service."""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import signal
import threading
from urllib.parse import urlsplit
import webbrowser

from .controller import Controller
from .transport import list_ports


STATIC = Path(__file__).parent / "static"
ASSETS = {"/": ("index.html", "text/html; charset=utf-8"),
          "/audio.js": ("audio.js", "text/javascript; charset=utf-8"),
          "/tooltips.js": ("tooltips.js", "text/javascript; charset=utf-8"),
          "/app.js": ("app.js", "text/javascript; charset=utf-8"),
          "/style.css": ("style.css", "text/css; charset=utf-8")}
MAX_BODY = 16384


class SynthServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port, controller):
        self.controller = controller
        self.sessions = set()
        self.session_lock = threading.Lock()
        super().__init__(("127.0.0.1", port), Handler)

    def new_session(self):
        with self.session_lock:
            if len(self.sessions) >= 64:
                raise ValueError("Too many tabs. Restart the bridge while stopped.")
            token = secrets.token_urlsafe(32)
            self.sessions.add(token)
            return token


class Handler(BaseHTTPRequestHandler):
    server_version = "OSSMSynth/0.1"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(3)

    def log_message(self, *args):
        pass  # Do not print control data, tokens or local serial paths.

    def _local_request(self):
        port = self.server.server_port
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin")
        if host not in hosts or (origin is not None and origin != "http://" + host):
            self._json(403, {"error": "Only same-origin loopback requests are accepted."})
            return False
        if self.headers.get("Sec-Fetch-Site") not in (None, "same-origin", "none"):
            self._json(403, {"error": "Cross-site requests are not accepted."})
            return False
        return True

    def _reply(self, status, body, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; "
                         "style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
                         "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, status, value):
        self._reply(status, json.dumps(value, allow_nan=False).encode(), "application/json")

    def do_GET(self):
        if not self._local_request():
            return
        path = urlsplit(self.path).path
        try:
            if path == "/api/session":
                self._json(200, {"token": self.server.new_session()})
            elif path == "/api/state":
                self._json(200, self.server.controller.state())
            elif path == "/api/ports":
                self._json(200, {"ports": list_ports()})
            elif path in ASSETS:
                name, content_type = ASSETS[path]
                self._reply(200, (STATIC / name).read_bytes(), content_type)
            else:
                self._json(404, {"error": "Not found."})
        except Exception as error:
            self._json(409, {"error": str(error)})

    def do_POST(self):
        if not self._local_request():
            return
        if self.path != "/api/action":
            self._json(404, {"error": "Not found."})
            return
        token = self.headers.get("X-Synth-Token", "")
        with self.server.session_lock:
            valid = token in self.server.sessions
        if not valid:
            self._json(403, {"error": "A local control session is required."})
            return
        if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
            self._json(415, {"error": "Expected application/json."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BODY or self.headers.get("Transfer-Encoding"):
                raise ValueError("Invalid request size.")
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError("Incomplete request.")
            def no_constant(value):
                raise ValueError("Non-finite JSON numbers are not accepted.")
            payload = json.loads(raw, parse_constant=no_constant)
            state = self.server.controller.action(payload, token)
            self._json(200, state)
        except (ValueError, TypeError, KeyError) as error:
            self._json(400, {"error": str(error)})
        except Exception as error:
            # A transport failure may be an uncertain write. Controller/transport latch it.
            self._json(409, {"error": str(error)})


def main(argv=None):
    parser = argparse.ArgumentParser(description="OSSM virtual synth, loopback browser UI; simulation by default")
    parser.add_argument("--port", type=int, default=8765, help="Local HTTP port (default 8765)")
    parser.add_argument("--open", action="store_true", help="Open the local interface in your browser")
    parser.add_argument("--allow-motion", action="store_true", help="Enable explicit hardware Home and 20-second Run controls; never auto-connect or auto-arm")
    args = parser.parse_args(argv)
    if not 1024 <= args.port <= 65535:
        parser.error("Port must be 1024..65535")
    controller = Controller(allow_motion=args.allow_motion)
    try:
        server = SynthServer(args.port, controller)
    except OSError as error:
        parser.exit(1, f"Cannot start local bridge: {error}\n")
    url = f"http://127.0.0.1:{server.server_port}"
    print(f"OSSM virtual synth: {url}", flush=True)
    print("Simulation selected. Serial devices open only after explicit connection.", flush=True)
    if args.allow_motion:
        print("Hardware control available: Connect → Home → Arm → Run; measured travel, 20-second runs.", flush=True)
    controller.start_worker()

    def stop_server(*_):
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGINT, stop_server)
    signal.signal(signal.SIGTERM, stop_server)
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        controller.close()
        server.server_close()


if __name__ == "__main__":
    main()
