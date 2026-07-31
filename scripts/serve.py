#!/usr/bin/env python3
"""
Tiny static server for the viewer.

    python scripts/serve.py [port]

ES modules and fetch() are blocked under file://, so the page must be served
over HTTP. Adds the correct MIME type for .json/.bin and disables caching so a
data refresh shows up on a plain reload.
"""

from __future__ import annotations

import functools
import http.server
import os
import socketserver
import sys
import webbrowser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
        ".bin": "application/octet-stream",
        ".geojson": "application/json",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):        # quieter console
        if "GET" in (args[0] if args else ""):
            status = args[1] if len(args) > 1 else ""
            if status.startswith("2") or status.startswith("3"):
                return
        super().log_message(fmt, *args)


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    handler = functools.partial(Handler, directory=ROOT)

    class Server(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True

    try:
        httpd = Server(("127.0.0.1", port), handler)
    except OSError as exc:
        print(f"cannot bind port {port}: {exc}")
        print(f"try a different port, e.g.  python scripts/serve.py {port + 1}")
        return 1

    url = f"http://localhost:{port}/"
    print(f"serving {ROOT}\n  ->  {url}\npress Ctrl+C to stop")
    try:
        webbrowser.open(url)
    except Exception:
        pass
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
