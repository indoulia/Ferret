# EPIC-004 — Architecture Decisions

Decisions taken while implementing Runtime Health & Diagnostics, with the
alternatives considered and the reason for selection (Governance §22, AI
Development Rule §19).

---

## D-001 — The diagnostic cannot fail

**Decision.** Nothing in `src/diagnostics/probe.ts` or `src/cli/health.ts`
propagates an exception. Every failure becomes a *result*.

**Reason.** Governance §20 requires `ferret status` and `ferret doctor` to stay
dependable when other subsystems are unhealthy — which is exactly when they are
worth running. A diagnostic that throws because the thing it was diagnosing is
broken is useless, and the hardest case proves the point: configuration itself
failing to parse is the one input the diagnostic needs in order to run, and it
still has to produce a report.

**Consequence.** Tests assert this against an unparseable configuration file, an
unresolvable secret reference, an unreachable database and wrong credentials —
each as a real process, each returning a report.

---

## D-002 — Health checks are read-only by construction

**Decision.** `probeHealth` forces `MigrationPolicy.OFF` on the storage provider.
The commands take no flag that would change it.

**Alternatives.** Trust callers not to pass `auto`; let `doctor` offer to fix
what it finds.

**Reason.** EPIC-004 requires health checks not to mutate. Enforcing it in one
place is stronger than documenting it, and it matters more than usual here
because an AI client will call `status` freely and without ceremony. A `status`
that migrated a schema would change the thing it was reporting on.

`doctor` therefore *advises* rather than repairs. A repair command is a separate,
explicitly-requested operation — EPIC-069 (Destructive Operation Confirmation)
governs anything of that shape.

---

## D-003 — `unknown` is not a synonym for `ok`

**Decision.** `unknown` ranks worse than `degraded` in the aggregation order. A
required component reporting `unknown` makes the whole report `unknown`, never
`ok`.

**Reason.** Governance §6 forbids manufacturing certainty. An operator told
"healthy" by a system that did not actually look has been misled, which is worse
than being told nothing. The ordering is the mechanical expression of that rule.

---

## D-004 — An optional component can never make Ferret unusable

**Decision.** In `aggregateStatus`, a non-`ok` optional component contributes
`degraded` regardless of its own status.

**Reason.** It is the criterion "health remains useful when optional providers
are unavailable". An absent pgvector means semantic retrieval is unavailable, not
that Ferret is: deterministic retrieval (EPIC-052, EPIC-053) does not need it. A
missing `git` disables repository features, not the product.

Without this rule the first optional provider to go down would take the whole
report to `unavailable`, and `status` would stop being informative on any
installation that had deliberately not enabled everything.

---

## D-005 — The summary headlines the actionable finding, not the worst one

**Decision.** The one-line summary sorts candidates by *required first*, then by
severity.

**Reason.** Found by running it. With a pending migration (`degraded`, required)
alongside capabilities that do not exist yet (`unknown`, optional), pure severity
ordering headlined "No index exists yet" — true, but not what the operator should
act on. The pending migration is fixable right now; an unimplemented capability
is not.

The aggregate verdict is unaffected; only which finding gets named changes. The
summary is what an operator reads first and often all they read, so naming the
wrong thing has a real cost.

---

## D-006 — Capabilities that do not exist yet are reported, not omitted

**Decision.** `plannedCapabilityComponents` reports `index-integrity` and
`synchronization` as `unknown`, with a remediation naming the owning Epic.

**Alternatives.** Omit them until they exist; report them as `ok`.

**Reason.** Reporting them `ok` would be a lie. Omitting them is subtler but
still misleading: an operator reading a clean bill of health would reasonably
conclude indexing had been checked. Governance §6 requires not-indexed to be
representable, so Ferret says so explicitly.

This is also why EPIC-004's "degraded index" required test is recorded as **NOT
APPLICABLE** rather than fabricated — see the validation evidence.

---

## D-007 — The exit code is attributed to what must be fixed

**Decision.** `exitCodeForHealth` picks the worst *required* failing component and
maps its `HealthArea` to a code: configuration → 3, schema → 6, anything else →
4. Degraded exits 0 unless `--strict`.

**Alternatives.** Always exit 0 and put health only in the payload; invent a
dedicated "unhealthy" code.

**Reason.** The Definition of Done requires deterministic classification, and a
code that identifies the *kind* of problem lets a script act without parsing
text. Reusing Ferret's published codes rather than inventing a scheme keeps one
contract.

"Not configured" (3) and "database down" (4) being different is the point: they
have different remediations, and conflating them sends the user to debug the
wrong thing.

Degraded exits 0 because Ferret is genuinely usable — failing a CI job because
pgvector is absent, on a project that does not use semantic search, would train
people to ignore the check.

---

## D-008 — A command may report an exit code without failing

**Decision.** `ProgramOptions.onExitCode` lets a command hand back a code;
`run()` returns it after a successful parse.

**Alternatives.** Throw a `FerretError` from `status`; write `process.exitCode`
directly in the action.

**Reason.** Throwing would be wrong: reporting that the database is down is a
*successful* execution of `status`, and turning it into an error would produce a
redacted error envelope instead of the report the user asked for. Writing
`process.exitCode` would be overwritten by `run()`, which returns `ExitCode.OK`
after a clean parse, and would leak between in-process test cases.

This is a small addition to EPIC-001's CLI contract, and the first command that
needed it made the gap obvious.

---

## D-009 — Composition lives in the CLI, aggregation lives in the core

**Decision.** `src/diagnostics` aggregates whatever components it is handed and
imports no provider. `src/cli/health.ts` is where PostgreSQL is chosen as the
storage to probe.

**Reason.** The boundary test forbids `pg` and Drizzle in the core import graph
(EPIC-002 D-001). Putting the storage probe in `src/diagnostics` would breach it
and drag a database driver into every consumer of `@indoulia/ferret`.

The split is also correct on its own terms: aggregating health is a domain
concern, deciding *which* storage exists is a composition concern. EPIC-014
(Provider Lifecycle & Health) will feed provider components through the same
seam without changing the core.

---

## D-010 — `status` and `doctor` share one probe

**Decision.** Both call `probeHealth`; `doctor` adds diagnosis and remediation on
top of the identical report.

**Reason.** Two commands that disagreed about whether Ferret was healthy would be
worse than either alone, and would be a bug nobody noticed for months. Sharing
the probe makes disagreement impossible, and a test asserts the two agree on the
verdict and on the component list.

The division of labour: `status` answers "is Ferret working", `doctor` answers
"what do I do about it". `doctor` lists only findings — a doctor that also
enumerates everything that is fine buries the one thing that is not.
