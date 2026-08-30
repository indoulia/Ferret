"""Process-pool worker for the concurrent indexing benchmark."""
import hashlib


def hash_chunk(paths):
    n = 0
    for p in paths:
        with open(p, "rb") as fh:
            hashlib.sha256(fh.read()).hexdigest()
        n += 1
    return n
