#!/usr/bin/env python3
"""Serve Flux Pond over http:// (ES modules need http://, not file://).

The bind address comes from the environment, in this order:

* `HOST` / `PASEO_PORT` -- injected by the Paseo daemon when this is started
  as a workspace service script, where the port is allocated rather than
  chosen (`HOST` is `0.0.0.0` so its proxy can reach the process).
* `PORT` -- the manual convention: `PORT=8123 python3 serve.py`.
* neither -- `127.0.0.1:8000`.
"""

import functools
import http.server
import os
import socketserver
import sys
from pathlib import Path

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8000
ROOT = Path(__file__).resolve().parent


class ConfigError(SystemExit):
    """An environment variable that cannot describe a socket."""


def listen_target(environ: dict[str, str]) -> tuple[str, int]:
    """Where to bind: Paseo's `HOST`/`PASEO_PORT` first, then `PORT`, then loopback."""
    host = environ.get("HOST")
    raw_port = environ.get("PASEO_PORT")
    if raw_port is None:
        raw_port = environ.get("PORT")
    if host is None:
        host = DEFAULT_HOST
    if raw_port is None:
        return (host, DEFAULT_PORT)
    try:
        port = int(raw_port)
    except ValueError as error:
        raise ConfigError(f"invalid port {raw_port!r}: not an integer") from error
    if not 1 <= port <= 65535:
        raise ConfigError(f"invalid port {port}: outside 1-65535")
    return (host, port)


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".html": "text/html",
    }

    def end_headers(self) -> None:
        # A phone keeps a preview pane's copy, and a stale page is a confusing
        # way to find out that the toy has changed.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        sys.stderr.write("%s - %s\n" % (self.address_string(), format % args))


def main() -> int:
    host, port = listen_target(os.environ)
    handler = functools.partial(Handler, directory=str(ROOT))
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer((host, port), handler) as server:
        server.daemon_threads = True
        print(f"Flux Pond on http://127.0.0.1:{port}/  (Ctrl-C to stop)", flush=True)
        if host not in ("127.0.0.1", "localhost"):
            print(f"  bound to {host}:{port}, so anything on this network can open it", flush=True)
        proxy_url = os.environ.get("PASEO_URL")
        if proxy_url is not None:
            print(f"  Paseo proxy: {proxy_url}", flush=True)
        server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
