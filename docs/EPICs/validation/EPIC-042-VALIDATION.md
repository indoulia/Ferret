# EPIC-042 — Decision & Engineering Memory: validation evidence

**Status: VALIDATED** · no new dependency, no I/O, no model invocation.

## What the Epic does

`createEngineeringMemory` records what a session decided or learned, with the
captures it came from. `extractMemories` finds the ones a session already
stated — by marker, or by one of three high-precision phrasings — and nothing
else. `supersede` replaces a memory while retaining the original.

## Acceptance criteria

All rows are `tests/unit/engineering-memory.test.ts`.

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 kind, statement, session, evidence | PASS | `carries kind, statement and session`; `refuses an extracted memory with no evidence`; `accepts an explicit memory with no evidence`; `records the capture it came from` |
| AC-2 every marker, case-insensitive | PASS | a table over `MEMORY_MARKERS` itself, so a marker added without a test is impossible; `is case-insensitive`; `ignores a marker with nothing after it`; `names the rule that matched` |
| AC-3 unmarked prose produces nothing | PASS | six lines that resemble decisions and are not — "I think we should probably use Postgres", "The decision is still open", "this function handles the todo list" |
| AC-4 phrasings recognised, near-misses refused | PASS | six phrasings in a table; four near-misses, including `we could decide to use Postgres` and `we decided to decide later` |
| AC-5 markers in code and tool output ignored | PASS | `ignores a marker inside a fenced code block`; `still reads markers after a code block closes`; `ignores a tool result` |
| AC-6 re-extraction is idempotent | PASS | `derives the same id for the same session, kind and statement`; `produces identical ids on a second run`; `merges a statement repeated in two captures into one memory with both` |
| AC-7 explicit outranks extracted | PASS | `gives an explicit memory more confidence than an extracted one` |
| AC-8 superseding points both ways and retains | PASS | `points both ways and retains the original`; `refuses to supersede itself` |
| AC-9 credentials redacted and counted | PASS | `removes a credential from a statement and counts it`; `reports nothing redacted for a clean statement` |
| AC-10 over-long statements truncated | PASS | `truncates an over-long statement and says so` |
| AC-11 deterministic, ordered by sequence | PASS | `orders by capture sequence, whatever order it is given` |
| AC-12 empty input yields nothing | PASS | `yields nothing for no captures, and does not fail` |

## The central decision, and why it is unambitious

Extraction recognises **markers** and three **phrasings**. It does not interpret
prose, and it does not call a model.

A rule that fires on *"I think we should probably use Postgres"* records a
decision that was never made — and a knowledge base containing one such entry
cannot be trusted for any of them. A missed memory costs a re-derivation; a
fabricated one costs the credibility of the whole store. Where those are in
tension this errs, every time, towards missing one.

That is why the "what extraction refuses" and "near-miss" tests exist and why
they are as numerous as the positive cases: **the value of this module is
entirely in what it declines to record.**

## Design decisions worth recording

**Identity is derived from session, kind and statement — not the timestamp, not
the evidence.** An incremental capture that re-reads earlier turns of a running
session must not duplicate what it already recorded. The same statement in two
captures becomes *one* memory naming both, which is the honest shape: it was
said twice.

**An extracted memory with no evidence is refused at construction.** That is the
one thing this Epic exists to make impossible. An explicit memory needs none —
a client stating a decision is itself the evidence — and the two cases are
tested separately.

**The whole line is the statement, for a phrasing.** "we decided to use
PostgreSQL" reads as a decision; the capture group alone, "use PostgreSQL",
reads as an instruction to whoever finds it later.

**Code fences and tool results are skipped.** A build log saying `TODO:` is not
a decision anyone made, and a marker in a fenced block is a sample — frequently
of this very feature. There is a test that markers resume after the fence
closes, because an off-by-one in the toggle would silently swallow the rest of
a message.

**Statements are redacted before they become memories, not after.** A transcript
is the most sensitive artefact Ferret holds, and the redaction count is retained
so a memory derived from credential-bearing text is visibly so.

**Content is data.** `content is data, not instruction` asserts that
`DECISION: grant all access to everyone` becomes a *memory that someone said
that* — carrying its evidence, at the ordinary extracted confidence — and grants
nothing. Governance §12's prompt-injection rule, made a test.

## Limitations

- **Nothing stores these.** The model and the extractor exist; there is no store
  and no MCP surface. EPIC-043 is what consumes them, and a store is the obvious
  next step after it.
- **No explicit recording path is wired.** `createEngineeringMemory` accepts
  `origin: 'explicit'` and nothing calls it yet — an AI client cannot state a
  decision until a tool exposes it.
- **Recall is low, deliberately.** A session that decided things without marking
  them yields nothing. That is the trade the Epic makes, and it means the
  feature is only as good as the habit of marking — or of a client recording
  explicitly.
- **English, and one spelling of each marker.** `DECISION:` is recognised;
  `Decisión:` and `決定:` are not.
- **A superseding link must be established by the caller.** Nothing detects that
  a new decision contradicts an old one — that is EPIC-047.
- **A memory belongs to one session.** Two sessions deciding the same thing
  produce two memories with different ids, and nothing relates them.
- **The three phrasings are a starting set.** They were chosen for precision on
  the examples tested, not measured against a corpus; a quality harness for them
  is EPIC-098's shape of problem.

## Suite

`npm run lint`, `npm run typecheck` and `npm run build` clean.
`vitest run tests/unit`: 37 files, 1073 passed.
