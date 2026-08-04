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
import json
import os
import socketserver
import subprocess
import sys
import threading
import urllib.parse
import webbrowser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# One update at a time: two concurrent fetch/build runs would fight over the
# same catalogue files.
_update_lock = threading.Lock()


def run_update(scope: str) -> dict:
    """Run the fetch + build chain for 'japan' or 'global'."""
    steps = ([["scripts/update.py"]] if scope == "japan"
             else [["scripts/fetch_global.py"], ["scripts/fetch_isc_global.py"],
                   ["scripts/build_global.py"]])
    # Captured pipes make Python fall back to the console codepage (cp949 on a
    # Korean Windows), which then dies on the non-ASCII place names the
    # fetchers print. Pin the child to UTF-8 on both ends.
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
    log = []
    for step in steps:
        p = subprocess.run([sys.executable, *step], cwd=ROOT, env=env,
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=7200)
        log.append((p.stdout or "")[-1500:] + (p.stderr or "")[-800:])
        if p.returncode != 0:
            return {"ok": False, "scope": scope, "failed": step[0],
                    "log": "\n".join(log)}
    return {"ok": True, "scope": scope, "log": "\n".join(log)[-3000:]}


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
        ".bin": "application/octet-stream",
        ".geojson": "application/json",
    }

    def do_POST(self):                     # noqa: N802 (stdlib naming)
        """`POST /api/update?scope=japan|global` -- runs the update scripts."""
        url = urllib.parse.urlparse(self.path)
        # Drain any body first, or the connection desynchronises on the reply.
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        if url.path.rstrip("/") != "/api/update":
            self.reply({"ok": False, "error": "unknown endpoint"}, 404)
            return
        scope = urllib.parse.parse_qs(url.query).get("scope", ["japan"])[0]
        if scope not in ("japan", "global"):
            scope = "japan"

        if not _update_lock.acquire(blocking=False):
            body = {"ok": False, "error": "already running"}
        else:
            try:
                print(f"[serve] update requested: {scope}", flush=True)
                body = run_update(scope)
                print(f"[serve] update {scope}: "
                      f"{'ok' if body['ok'] else 'FAILED'}", flush=True)
            except Exception as exc:       # a failed update must not kill the server
                body = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
            finally:
                _update_lock.release()

        self.reply(body, 200)

    def reply(self, obj: dict, code: int) -> None:
        payload = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

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
