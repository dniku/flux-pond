#!/usr/bin/env python3
"""Serve Flux Pond on http://127.0.0.1:8000/ (ES modules need http://, not file://)."""

import functools
import http.server
import os
import socketserver
import sys
from pathlib import Path

PORT = int(os.environ.get("PORT", "8000"))
ROOT = Path(__file__).resolve().parent


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".html": "text/html",
    }

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        sys.stderr.write("%s - %s\n" % (self.address_string(), format % args))


def main() -> int:
    handler = functools.partial(Handler, directory=str(ROOT))
    with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), handler) as server:
        server.daemon_threads = True
        print(f"Flux Pond on http://127.0.0.1:{PORT}/  (Ctrl-C to stop)", flush=True)
        server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
