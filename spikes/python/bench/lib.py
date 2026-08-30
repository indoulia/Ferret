"""Shared helpers for the Ferret Python evaluation spike.

Mirrors spikes/typescript/bench/lib.mjs so both runtimes emit the same
result contract and face the same corpus.
"""
import hashlib
import json
import statistics
import sys
import time
from pathlib import Path

SPIKES = Path(__file__).resolve().parents[2]
CORPUS = SPIKES / "corpus"
DOCS = CORPUS / "docs"
CODE = CORPUS / "code"
MALFORMED = CORPUS / "malformed"
LARGE = CORPUS / "large"
REPO = SPIKES.parent


def stats(samples):
    s = sorted(samples)
    return {"median": statistics.median(s), "min": s[0], "max": s[-1], "n": len(s)}


def emit(benchmark, unit, samples, meta=None):
    out = {"benchmark": benchmark, "runtime": "python", "unit": unit,
           "samples": samples, **stats(samples), "meta": meta or {}}
    sys.stdout.write(json.dumps(out) + "\n")


class timed:
    def __enter__(self):
        self.t = time.perf_counter()
        return self

    def __exit__(self, *a):
        self.ms = (time.perf_counter() - self.t) * 1000.0
        return False


def walk(root: Path):
    return [p for p in root.rglob("*") if p.is_file()]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
