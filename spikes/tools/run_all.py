"""EPIC-005 benchmark orchestrator.

Runs every benchmark for both candidate runtimes, records raw results and
environment metadata under spikes/results/, and exits non-zero if any
benchmark fails. Uses only the standard library so it can run before either
candidate stack is selected.

Usage:
  python spikes/tools/run_all.py [--only NAME] [--skip-postgres]

Requires FERRET_PG_URL for the postgres benchmark.
"""
import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import time
from pathlib import Path

SPIKES = Path(__file__).resolve().parents[1]
TS = SPIKES / "typescript"
PY = SPIKES / "python"
RESULTS = SPIKES / "results"
RAW = RESULTS / "raw"
PYEXE = PY / ".venv" / "Scripts" / "python.exe"
if not PYEXE.exists():
    PYEXE = PY / ".venv" / "bin" / "python"

# name -> (node argv, python argv) relative to their spike dirs
BENCHMARKS = {
    "memory": (["bench/run.mjs", "memory"], ["bench/run.py", "memory"]),
    "fsscan": (["bench/run.mjs", "fsscan"], ["bench/run.py", "fsscan"]),
    "concurrency": (["bench/run.mjs", "concurrency"], ["bench/run.py", "concurrency"]),
    "git": (["bench/run.mjs", "git"], ["bench/run.py", "git"]),
    "pdf": (["bench/run.mjs", "pdf"], ["bench/run.py", "pdf"]),
    "docx": (["bench/run.mjs", "docx"], ["bench/run.py", "docx"]),
    "xlsx": (["bench/run.mjs", "xlsx"], ["bench/run.py", "xlsx"]),
    "csv": (["bench/run.mjs", "csv"], ["bench/run.py", "csv"]),
    "treesitter": (["bench/run.mjs", "treesitter"], ["bench/run.py", "treesitter"]),
    "largefile": (["bench/run.mjs", "largefile"], ["bench/run.py", "largefile"]),
    "robustness": (["bench/run.mjs", "robustness"], ["bench/run.py", "robustness"]),
    "postgres": (["bench/run.mjs", "postgres"], ["bench/run.py", "postgres"]),
    "mcp": (["bench/mcp-client.mjs"], ["bench/mcp_client.py"]),
}


def run(cmd, cwd, timeout=3600):
    t = time.perf_counter()
    cp = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True, timeout=timeout)
    return cp, (time.perf_counter() - t) * 1000.0


def parse_results(stdout):
    out = []
    for line in stdout.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return out


def measure_startup(cmd, cwd, n=20):
    """Wall-clock spawn-to-exit, the cost an AI client pays per session."""
    samples = []
    for _ in range(n):
        t = time.perf_counter()
        subprocess.run(cmd, cwd=str(cwd), capture_output=True)
        samples.append((time.perf_counter() - t) * 1000.0)
    s = sorted(samples)
    return {"samples": samples, "median": s[len(s) // 2], "min": s[0], "max": s[-1], "n": n}


def dir_bytes(p: Path):
    if not p.exists():
        return None
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file())


def dir_files(p: Path):
    if not p.exists():
        return None
    return sum(1 for f in p.rglob("*") if f.is_file())


def footprint():
    nm = TS / "node_modules"
    venv = PY / ".venv"
    sp = venv / "Lib" / "site-packages"
    if not sp.exists():
        sp = next((venv / "lib").glob("python*/site-packages"), sp)
    pip_dir = sp / "pip"
    lock = TS / "package-lock.json"
    npkgs = None
    if lock.exists():
        npkgs = len(json.loads(lock.read_text(encoding="utf-8")).get("packages", {})) - 1
    pylock = PY / "requirements.lock.txt"
    pypkgs = len([x for x in pylock.read_text(encoding="utf-8").splitlines() if x.strip()]) \
        if pylock.exists() else None
    return {
        "node": {"bytes": dir_bytes(nm), "files": dir_files(nm), "packages": npkgs},
        "python": {
            "venv_bytes": dir_bytes(venv),
            "site_packages_bytes": dir_bytes(sp),
            "pip_bytes": dir_bytes(pip_dir),
            "files": dir_files(venv),
            "packages": pypkgs,
        },
    }


def environment():
    def ver(cmd):
        try:
            return subprocess.run(cmd, capture_output=True, text=True).stdout.strip().splitlines()[0]
        except Exception:  # noqa: BLE001
            return None
    return {
        "generated_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "os": platform.platform(),
        "machine": platform.machine(),
        "cpu_count": os.cpu_count(),
        "node": ver(["node", "--version"]),
        "npm": ver([shutil.which("npm") or "npm", "--version"]),
        "python": ver([str(PYEXE), "--version"]),
        "git": ver(["git", "--version"]),
        "docker": ver(["docker", "--version"]),
        "postgres_url_set": bool(os.environ.get("FERRET_PG_URL")),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", action="append", default=None)
    ap.add_argument("--skip-postgres", action="store_true")
    args = ap.parse_args()

    if not (SPIKES / "corpus" / "CORPUS.json").exists():
        print("corpus missing: run spikes/tools/gen_corpus.py first", file=sys.stderr)
        return 1

    RAW.mkdir(parents=True, exist_ok=True)
    report = {"environment": environment(), "footprint": footprint(),
              "startup": {}, "benchmarks": {}, "failures": []}

    print("== startup ==", flush=True)
    report["startup"]["node_runtime"] = measure_startup([shutil.which("node") or "node", "-e", "0"], TS)
    report["startup"]["python_runtime"] = measure_startup([str(PYEXE), "-c", "pass"], PY)
    report["startup"]["node_app"] = measure_startup(
        [shutil.which("node") or "node", "bench/startup.mjs"], TS, n=10)
    report["startup"]["python_app"] = measure_startup([str(PYEXE), "bench/startup.py"], PY, n=10)
    for k, v in report["startup"].items():
        print(f"  {k:16s} median {v['median']:.1f} ms", flush=True)

    selected = args.only or list(BENCHMARKS)
    for name in selected:
        if name not in BENCHMARKS:
            print(f"unknown benchmark {name}", file=sys.stderr)
            return 2
        if name == "postgres" and (args.skip_postgres or not os.environ.get("FERRET_PG_URL")):
            print(f"== {name} == SKIPPED (no FERRET_PG_URL)", flush=True)
            report["benchmarks"][name] = {"skipped": "FERRET_PG_URL not set"}
            continue
        node_argv, py_argv = BENCHMARKS[name]
        entry = {}
        for runtime, argv, cwd, exe in (
            ("node", node_argv, TS, shutil.which("node") or "node"),
            ("python", py_argv, PY, str(PYEXE)),
        ):
            print(f"== {name} / {runtime} ==", flush=True)
            cp, wall = run([exe, *argv], cwd)
            res = parse_results(cp.stdout)
            if cp.returncode != 0 or not res:
                report["failures"].append(
                    {"benchmark": name, "runtime": runtime, "exit": cp.returncode,
                     "stderr": cp.stderr[-500:]})
                print(f"  FAILED exit={cp.returncode}: {cp.stderr[-300:]}", flush=True)
                continue
            entry[runtime] = {"wall_ms": wall, "results": res}
            for r in res:
                print(f"  {r['benchmark']:22s} median {r['median']:.3f} {r['unit']}", flush=True)
        report["benchmarks"][name] = entry

    (RAW / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\nwrote {RAW / 'report.json'}")
    if report["failures"]:
        print(f"{len(report['failures'])} benchmark failure(s)", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
