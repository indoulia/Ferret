# EPIC-082 — Secret Detection & Exclusion: validation evidence

**Status: VALIDATED** · real PostgreSQL 17, real `git`.

## Before

A repository with a `.env`, a `certs/*.pem` and a commit message naming rotated
keys, indexed with the previous build:

```
(MCP) ferret_search "a0ff698"  →  AKIAIOSFODNN7EXAMPLE
                                  ghp_1234567890abcdefghijklmnopqrstuvwx
```

`.env` and `secrets/prod-db-password.txt` indexed as file entities. None of the
ten `DEFAULT_EXCLUSIONS` concerned secrets.

## After

Same repository, same query: nothing. Database-wide scan for each credential
returns 0 rows across `entity`, `evidence` and `relationship`.

## Acceptance criteria

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 provider formats redacted | PASS | 10 pattern tests, one per format |
| AC-2 value never stored | PASS | `stores none of them, anywhere` — scans all three tables |
| AC-3 surrounding text survives | PASS | `keeps everything around the credential` |
| AC-4 secret paths excluded | PASS | `excludes the files that hold credentials` |
| AC-5 `.env.example` kept | PASS | `keeps the example files` |
| AC-6 skips reported | PASS | `reports what it skipped` |
| AC-7 policy cannot disable | PASS | detection is in the provider, not in configurable exclusions |
| AC-8 counts by kind, never values | PASS | `counts by kind and never carries the value` |
| AC-9 no false positives on real corpus | PASS | see below |
| AC-10 branch names covered | PASS | `ref` and `shortName` redacted at emission |

## AC-9, and what it found

Run over 400 real commit messages from this repository. One match:
`assigned-secret` on `DATABASE_PASSWORD=hunter2`, quoted from a test fixture in
an EPIC-008 checkpoint commit. **A genuine match, not a false positive** — the
test asserts no *provider format* fires and documents this one.

Also run over every tracked path: zero exclusions, so no real source is lost.

## Defects found while building

1. **`AWS_SECRET_ACCESS_KEY=` did not match.** The keyword had to be the last
   token before `=`; the canonical AWS variable name has `_ACCESS_KEY` after
   `SECRET`. Pattern now allows a trailing run.
2. **History bypassed the path gate.** `emitFiles` refused `.env`, and
   `emitHistory` created the entity anyway from the commit that touched it.
   Caught by the integration test asserting the database, not the report.
3. **Ferret's own packaging scan flagged the detector.** A comment contained a
   literal `scheme://user:pass@` example. The scan was right; the comment was
   reworded.

## Limitations

- **File content is not scanned** — nothing indexes it yet. EPIC-024–030 must
  route through the same gate.
- **`secrets/prod-db-password.txt` is still indexed.** Excluding on fuzzy
  filename substrings (`password`, `secret`) would drop real source such as
  `password-reset.ts`. Exclusions are additive, so over-excluding cannot be
  undone by the person it hurts. Content scanning is where this gets caught.
- **No entropy detection.** Precision on source code is poor.
- **No retroactive scrub** of an already-built index; EPIC-090 owns that.

## Suite

`55 files, 1332 passed, 3 skipped`. `npm audit`: 0.
