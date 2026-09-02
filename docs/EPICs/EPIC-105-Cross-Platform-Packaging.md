# EPIC-105 — Cross-Platform Packaging

**Status: VALIDATED | Priority: P1 | Domain: Distribution**

> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> Registered in the [Epic registry](README.md) under Distribution; only the
> specification is new.

## 1. Objective

Find out whether Ferret works on macOS, and record the answer — because
**nineteen** validation documents currently say nobody knows.

## 2. Value

Nineteen validation records park the same gap on this Epic. EPIC-001's is the
original:

> *"**macOS not validated.** No macOS host was available, and none is in CI. No
> macOS support is claimed."*

And `.github/workflows/ci.yml` says the same thing where it matters most —
in the matrix that decides what is measured:

> *"macOS is deliberately absent: no macOS host was available to validate
> against, and EPIC-005 recorded closing that gap as EPIC-105's work. Claiming
> macOS support here without measuring it would be false."*

That comment is correct and it is also the whole problem. **A macOS host is
available** — GitHub's hosted runners include one — so the reason the gap exists
has expired. Ferret is a developer tool distributed through npm, and a
substantial share of the developers it is for are on macOS. Shipping to them
with nineteen documents saying "unvalidated" is not a limitation; it is an
absence of information that a two-line matrix change removes.

- **EPIC-005 §11-1** — "macOS packaging unvalidated. Recommend accepting this as
  EPIC-105 scope… EPIC-105 owns packaging validation."
- **EPIC-001 §71** — "macOS remains unvalidated and is carried to EPIC-105."
- **EPIC-002, EPIC-081 §4** and fifteen more validation records, all the same
  row.
- **EPIC-102/103/104 §4** — "Cross-platform packaging beyond Node's own reach
  (EPIC-105)."

## 3. Scope

- **macOS in the CI matrix**, running the same `verify` job Linux and Windows
  run.
- **A recorded answer** — what passes, what skips, and what does not work.
- **Closing the nineteen rows**, or replacing each with a *measured* limitation
  rather than an unmeasured one.
- **Deciding where macOS runs** — on every pull request or after a merge — from
  its measured duration, on the same evidence Windows was moved on.

## 4. Non-scope

- **Native binaries, installers or a Homebrew formula.** Ferret is distributed
  through npm (EPIC-102/103/104) and that is unchanged. "Cross-platform
  packaging" here means *the npm package works on those platforms*, not that
  new package formats exist.
- **Signing or notarisation.** Ferret ships JavaScript, not a Mach-O binary, so
  there is nothing to notarise. §16 records what would change if that stopped
  being true.
- **Linux distributions other than the runner's.** One Ubuntu is what CI has;
  claiming Alpine or musl without measuring it would repeat exactly the mistake
  this Epic exists to correct.
- **Docker on macOS.** GitHub's macOS runners cannot run Linux containers, so
  the storage suites skip there for the same reason they skip on Windows —
  §8.3, and the asymmetry is stated rather than hidden.
- **Windows arrangements.** The post-merge decision EPIC-102/103/104 recorded
  stands; this Epic does not revisit it beyond applying the same reasoning to a
  new platform.

## 5. Inputs

GitHub's `macos-latest` runner; the existing `verify` job; the nineteen
validation records.

## 6. Outputs

`.github/workflows/ci.yml` with macOS in the matrix, and
`validation/EPIC-105-VALIDATION.md` carrying what the run measured.

## 7. Dependencies

EPIC-001 (the runtime and the package), EPIC-102/103/104 (distribution),
EPIC-002 (the storage suites that will skip).

## 8. Contracts

### 8.1 The validation environment is CI, and that is the Epic's shape

Every other Epic in this project is validated on a developer machine and
confirmed by CI. This one **cannot be**: the whole content of the nineteen rows
is that no macOS host is available locally. So the evidence is a CI run, and the
Epic's honesty depends on the run happening *before* the merge rather than after
it — §8.2.

### 8.2 macOS runs on the pull request that introduces it

Windows was moved off the PR gate on measured evidence — "Ubuntu verify took
1m52s–2m55s and Windows 6m41s–11m54s, so Windows was the whole of the wait on
every one of six PRs." macOS gets the same treatment, but **not before it is
measured**: it runs on this Epic's own pull request, and where it runs
afterwards is decided from that duration.

Deciding first and measuring later would be guessing, which is the failure mode
this Epic exists to end.

### 8.3 A skip is recorded as a skip, never as a pass

The storage suites need a Linux container and macOS runners cannot run one, so
they skip — exactly as they do on Windows, and for the same reason the workflow
already records: *"attempting it in this matrix would produce coverage on Linux
and a silent skip on Windows — an asymmetry that is easy to mistake for a
passing gate."*

So the validation record states what macOS **did not** run, not only what
passed. A platform that was 60% measured and reported as "validated" would be
worse than one honestly unmeasured.

### 8.4 A failure is a finding, not a reason to abandon the Epic

If macOS fails, the failure is recorded and the nineteen rows are replaced with
a **measured** limitation naming what does not work. That is a strictly better
state than "nobody knows", and it is the outcome this Epic must be willing to
deliver — otherwise the incentive is to not look.

### 8.5 Signals will newly run, and that is the first thing to watch

EPIC-001 recorded that `SIGTERM` is undeliverable on Windows, so three
signal-handling tests skip there. **macOS supports both signals**, so those
tests will run for the first time outside Linux. If they fail it is a real
finding about Ferret's shutdown path, not about the platform.

### 8.6 Nothing about the package changes to make macOS pass

If macOS needs a code change, that change is a defect fix with its own reasoning
— not a platform special case bolted into the build. §16 records that no such
change was needed, or names the one that was.

### 8.8 The duration is recorded, and §8.9 decides from it

Ubuntu's, Windows's and macOS's `verify` durations recorded together, so the
next platform decision is made against numbers rather than against a memory of
how slow something felt.

### 8.9 Where macOS runs afterwards follows from §8.8

Kept on the pull-request gate, or moved to post-merge like Windows, decided from
the measured duration and recorded with the reasoning. Deciding first and
measuring later would be the guess this Epic exists to end.

## 9. Acceptance criteria

- **AC-1** `macos-latest` is in the `verify` matrix.
- **AC-2** macOS runs on this Epic's own pull request, so the evidence precedes
  the merge.
- **AC-3** Lint, typecheck and build succeed on macOS.
- **AC-4** The unit and integration suites pass on macOS, database suites
  excepted.
- **AC-5** The packaging suite passes on macOS — `npm pack`, a global install,
  and the installed binary running.
- **AC-6** The three signal tests EPIC-001 skips on Windows **run** on macOS.
- **AC-7** The validation record names every suite that skipped, and why.
- **AC-8** The measured macOS duration is recorded beside Ubuntu's and
  Windows's.
- **AC-9** Where macOS runs afterwards is decided from AC-8, with the reasoning
  recorded.
- **AC-10** The nineteen macOS rows are struck, or replaced with a measured
  limitation.
- **AC-11** No source change was needed to make macOS pass — or the one that
  was is a defect fix with its own reasoning (§8.6).
- **AC-12** The workflow comment that said macOS was absent is replaced with
  what is now true.

## 10. Test requirements

**CI** — all of it. There is no local macOS host, which is the premise.

**Regression** — the Ubuntu and Windows jobs unchanged in what they run.

## 11. Security requirements

None added. The macOS job runs the same suites, including the security ones,
which is itself the point: EPIC-100's regression suite has never run on macOS.

## 12. Observability

The CI run is the observability. Durations are recorded in the validation
document so a later Epic compares rather than re-measures.

## 13. Performance constraints

One more matrix leg. §8.2 decides whether it sits on the PR gate from its
measured cost, which is the same decision Windows already went through.

## 14. Definition of Done

Scope implemented; AC-1 to AC-12 with evidence in
`validation/EPIC-105-VALIDATION.md`; the nineteen macOS rows struck or
re-measured; the registry updated; EPIC-005 §11-1's governance acceptance
recorded as discharged.

## 15. Governance alignment

- **§6 Evidence Before Inference** — the whole Epic. Nineteen documents assert
  an absence of knowledge; this replaces it with a measurement.
- **§21 Reproducibility** — the evidence is a CI run anyone can re-trigger.
- **§13 Diagnosability** — §8.3: a skip is recorded as a skip.

## 16. Raised, not absorbed

- **One macOS version, one architecture.** `macos-latest` is whatever GitHub
  currently pins, on Apple silicon. Intel macOS is not measured, and an older
  macOS is not measured — claiming either would be the same mistake this Epic
  corrects.
- **No Docker on macOS**, so the storage suites are validated on Linux only.
  That is the same state Windows is in, and neither is a claim that PostgreSQL
  behaves identically there.
- **No signing or notarisation**, because Ferret ships JavaScript. If a future
  Epic ships a native binary or a `pkg` bundle, notarisation becomes real work
  and this Epic's non-scope stops being adequate.
- **~~Alpine and musl are unmeasured.~~ Measured 2026-09-03 by EPIC-107.** The
  Docker image is `node:22-alpine`, and a probe run inside it parsed TypeScript
  through the real provider: `{"parserId":"ferret.parser.code","symbols":
  ["arrow","named","Thing"],"segments":4}`. `tree-sitter`'s WASM grammars load
  on musl; all four ship in the image.
- **A nightly macOS run is not added.** Windows has one; if macOS moves off the
  PR gate, it should get the same nightly, and §8.9's decision records whether
  it did.

## 17. Recorded during implementation

**Nothing broke.** No source change was needed, no test failed, and no platform
special case was added. That is the least interesting possible outcome and the
one most worth recording plainly, because the alternative was nineteen documents
continuing to say "nobody knows" on the strength of nobody looking.

**macOS stays on the pull-request gate**, which is §8.9's decision made from
§8.8's measurement: 3m47s against Ubuntu's 3m02s. Windows was moved off the gate
on evidence of a different magnitude — 6m41s to 11m54s, "the whole of the wait
on every one of six PRs" — and that argument does not transfer to 45 seconds.

**Two of the nineteen rows were not about macOS**, and a blanket note would have
misdescribed them. `SIGTERM` is undeliverable on Windows whatever macOS does, so
that row stands with only the half this Epic answered recorded; and "database
tests are skipped on Windows" got *broader* rather than narrower, since the same
is true of macOS. Both were corrected by reading them rather than by the rewrite
that struck the other sixteen — which is the standard EPIC-070's limitation
sweep asks for, applied here to this Epic's own rows.

Full evidence in [validation](validation/EPIC-105-VALIDATION.md).
