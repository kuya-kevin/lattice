"""Spike E: local server for the blind listening test.

Each subfolder of STIMULI is one trial: reference.wav plus one WAV per candidate
(optimizer.wav, muse_only.wav, mrt2.wav, freesound.wav, ...). Ratings append to
ratings.jsonl next to this file's output dir. Standard library only, so the same
static page can later sit behind Cloudflare Access with a small API in front.

    uv run python e_eval/server.py ../out/c_recreate [port]
"""
import json
import sys
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

STIMULI = Path(sys.argv[1] if len(sys.argv) > 1 else "../out/c_recreate").resolve()
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8765
STATIC = Path(__file__).parent / "static"
RATINGS = STIMULI.parent / "eval" / "ratings.jsonl"


def trials():
    out = []
    for d in sorted(p for p in STIMULI.iterdir() if (p / "reference.wav").exists()):
        candidates = sorted(w.stem for w in d.glob("*.wav") if w.stem != "reference")
        # The hidden reference checks the rater: it should score near 100.
        out.append({"id": d.name, "candidates": candidates + ["hidden_reference"]})
    return out


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(STATIC), **kw)

    def log_message(self, *_):
        pass

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/trials":
            return self._json(trials())
        if self.path.startswith("/audio/"):
            trial, _, name = self.path[len("/audio/"):].partition("/")
            stem = "reference" if name == "hidden_reference.wav" else Path(name).stem
            f = (STIMULI / trial / f"{stem}.wav").resolve()
            if STIMULI not in f.parents or not f.exists():
                return self._json({"error": "not found"}, 404)
            data = f.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        return super().do_GET()

    def do_POST(self):
        if self.path != "/api/ratings":
            return self._json({"error": "not found"}, 404)
        rating = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        rating["received_at"] = time.time()
        RATINGS.parent.mkdir(parents=True, exist_ok=True)
        with RATINGS.open("a") as f:
            f.write(json.dumps(rating) + "\n")
        return self._json({"ok": True})


if __name__ == "__main__":
    print(f"listening test: http://localhost:{PORT}  (stimuli {STIMULI}, ratings {RATINGS})")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
