# EPIC-005 Evaluation Spikes

Benchmark and evaluation artefacts for **EPIC-005 — Technology Evaluation &
Selection**. This is **not Ferret**. Nothing here ships. Its only purpose is to
produce evidence for the decisions recorded in `docs/TECHNOLOGY-DECISIONS.md`.

Per EPIC-005 non-scope: *"This Epic produces benchmark and evaluation artefacts
plus recorded decisions, not product features."*

## Layout

```
spikes/
  tools/
    gen_corpus.py      deterministic corpus (seed 20260830)
    gen_malformed.py   malformed / adversarial / large inputs
    run_all.py         orchestrator: runs every benchmark for both runtimes
    report.py          renders results/RESULTS.md from raw evidence
    decide.py          computes the weighted decision matrix
  typescript/          Node.js 22 spike (bench/)
  python/              Python 3.12 spike (bench/)
  results/
    RESULTS.md         generated comparison
    raw/               committed evidence (JSON)
  corpus/              generated, gitignored
```

## Reproducing

Requires Node 22+, Python 3.12+, Git, and Docker (for PostgreSQL).

```bash
# 1. dependencies
cd spikes/typescript && npm ci && cd ../..
python -m venv spikes/python/.venv
spikes/python/.venv/Scripts/python -m pip install -r spikes/python/requirements.txt
spikes/python/.venv/Scripts/python -m pip install -r spikes/python/requirements-gen.txt

# 2. corpus (~110 MB, deterministic)
python spikes/tools/gen_corpus.py
python spikes/tools/gen_malformed.py

# 3. PostgreSQL with pgvector
docker run -d --name ferret-bench-pg -e POSTGRES_PASSWORD=bench \
  -e POSTGRES_DB=ferretbench -p 55433:5432 pgvector/pgvector:pg17
export FERRET_PG_URL="postgresql://postgres:bench@127.0.0.1:55433/ferretbench"

# 4. run, report, decide
python spikes/tools/run_all.py
python spikes/tools/report.py
python spikes/tools/decide.py
```

`run_all.py --only NAME` runs a single benchmark; `--skip-postgres` skips the
database benchmark.

## Methodology notes

- Both runtimes parse **identical bytes**. The corpus is generated once from a
  fixed seed; generation is not measured.
- Every benchmark reports a **median of repeated runs**, not a single sample.
- Where an implementation choice could bias a result, **both strategies are
  measured and each runtime is credited with its best** (`fsscan` sequential vs
  parallel; `concurrency` process pool vs thread pool). Three benchmarks were
  rewritten mid-evaluation for exactly this reason — see the fairness-corrections
  section of `results/RESULTS.md`.
- Adversarial parsing runs **one isolated process per case** with a timeout, so a
  hang or crash is observable rather than fatal to the run.

## Retention

These artefacts are the evidence behind an architectural decision and are kept
for as long as that decision stands (Governance §22, AI Development Rules §19).
They are not maintained as product code and are not covered by product CI.

## Dependency advisories in the spikes

The spikes are EPIC-005 evaluation code. They are `private`, they are not built,
not published, not installed by the repository's `npm ci`, and not run in CI —
but their lockfiles are still scanned, so an advisory against one of them appears
alongside advisories against the product.

That is worth keeping true rather than filtering away. An alert list with a
permanent known-ignorable entry is an alert list people stop reading, which is a
worse outcome than the advisory itself.

**GHSA-w5hq-g745-h8pq** (`uuid` < 11.1.1, a missing buffer bounds check in the
v3/v5/v6 generators when a `buf` argument is supplied) reached the TypeScript
spike transitively through `exceljs`, which requires `uuid@^8.3.0`. Ferret itself
has never depended on `uuid`. Resolved by pinning `uuid@^11.1.1` through an
`overrides` entry in `spikes/typescript/package.json`, so the spike is
reproducible and the alert list stays meaningful.
