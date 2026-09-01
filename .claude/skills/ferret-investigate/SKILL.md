---
name: ferret-investigate
description: Investigate Ferret defects and unexpected behavior by reproducing, measuring, tracing ownership, and proving the smallest correct fix before editing code.
---

# Ferret Investigation

Use this skill for bugs, regressions, surprising runtime behavior, flaky tests, and claims of root cause.

## Required workflow

1. **Reproduce first.** Establish the failure or surprising behavior on current `main` before proposing a fix.
2. **Measure before inferring.** Prefer runtime evidence, integration tests, database state, logs, and actual lifecycle paths over code-reading assumptions.
3. **Trace the real path.** Follow the caller chain used by production/CLI/runtime code, not only the isolated function named in a test.
4. **Find the owner.** Determine which existing Epic, contract, provider boundary, or subsystem owns the behavior.
5. **State causality precisely.** Separate observed facts, hypotheses, and conclusions. Do not attribute one open issue to another without a reproducing measurement.
6. **Choose the smallest correct fix.** Do not refactor adjacent code or expand scope merely because it is convenient.
7. **Add a regression test.** The test must exercise the failure mechanism, not merely the corrected implementation.
8. **Verify the real path.** For lifecycle/integration defects, add or run integration coverage that reproduces the original lifecycle.
9. **Re-check after the fix.** Run focused tests, relevant regression suites, and lint/typecheck/build/verify as applicable.

## Anti-patterns

- A green unit test is not proof that the production path works.
- Do not manufacture a distinction the underlying system cannot observe.
- Do not call correlation a root cause.
- Do not weaken an existing boundary assertion to make a design fit.
- Do not rewrite historical evidence to match the new behavior.
- Do not close an issue merely because a nearby fix is useful.

## Output checkpoint

Report only:
- reproduction
- observed facts
- root cause
- ownership
- smallest fix
- regression test
- verification
- remaining uncertainty

If ownership or intended behavior is genuinely ambiguous, stop for a governance decision instead of choosing silently.
