# EPIC-084 — Prompt-Injection Resistance: validation evidence

**Status: VALIDATED** · no new table, no new entity, no migration. One security
module, one field on every content-bearing response, one hardened notice.

## What the Epic does

Repository text is emitted inside a boundary it cannot forge, marked when it
reads as an instruction, and never filtered. `contentSafety` reports what was
contained and what was marked, so a client can weight an answer rather than have
to read it first.

Before this Epic the only control was `CONTENT_NOTICE` — a sentence asking a
model not to obey what follows. That is mitigation by instruction: necessary,
untestable, and defeated by any content that out-argues it. It is still there,
and it now names the mechanism instead of only stating the rule.

## Acceptance criteria

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 every content-bearing field contained, notice names the delimiter | PASS | `ferret_search`, `ferret_find`, `ferret_get_entity`, `ferret_neighbours` and context packs all route attributes through `containAttributes`; `CONTENT_NOTICE` names both delimiters and the `contentSafety` field |
| AC-2 delimiter neutralised, value otherwise unchanged, count reported | PASS | `tests/unit/containment.test.ts` — a value that closes its own container, and one containing four delimiters; exactly one of each survives, at the ends |
| AC-3 marks injections, not ordinary prose or code | PASS | 8 injection phrasings marked with the expected signal; 6 ordinary strings unmarked; the security module's own doc comment — which discusses injection — unmarked |
| AC-4 a marked value is returned whole | PASS | `marking never filters` — the payload is contained in full; a 20,000-character value is not truncated; and against real PostgreSQL the hostile file stays `active` and findable |
| AC-5 a hostile repository is indexed, findable, returned and marked | PASS | `tests/integration/indexing/hostile-content.test.ts` — a doc comment carrying a real payload travels from a `.ts` file through EPIC-108's content stage into a `code_symbol`, and comes back contained and marked |
| AC-6 content reaches no control path | PASS | `tests/unit/boundaries.test.ts` — seven content-handling modules import none of `node:fs`, `node:path`, `node:child_process`, `node:net`, `node:http(s)`, `node:worker_threads`, load no module at runtime, and reach no `storage/` module or query builder |
| AC-7 redaction still runs first | PASS | Unchanged: `redactSecrets` is applied at the EPIC-024 framework boundary before anything here; a secret inside instruction-shaped text is redacted and the value is still marked |
| AC-8 the notice is present and first | PASS | `tests/integration/mcp/tools.test.ts` — every tool carries it, and it precedes the content in the serialised response |
| AC-9 no measurable cost without content | PASS | `NO_CONTENT_SAFETY` is a frozen constant returned when nothing was contained; classification is bounded to 4096 characters per field |

## Dogfooding

Ferret's own repository, indexed with content on, queried through the MCP
surface. A live symbol:

```
"name":          "runContentStage",
"path":          "src/indexing/content.ts",
"signature":     "␂ferret:content␂export async function runContentStage(␃ferret:content␃",
"documentation": "␂ferret:content␂/** Runs the content stage over one repository's files. … ␃ferret:content␃",
"startLine":     166,
"modifiers":     ["export", "async"]
```

Prose contained; `path`, `name` and `qualifiedName` left matchable; numbers and
arrays untouched. The oracle, `npm run dogfood -- --content`, still agrees with
the repository on all eleven checks — including `structure recorded (236 source
files)` and `no phantom files (427 active)`, both of which compare
`attributes.path` against `git ls-files` and would fail if containment had
wrapped it.

## What building this found

**The AC was wrong, not the classifier.** AC-3 originally said the classifier
must not mark "this specification". The test that enforced it failed against the
specification's own quoted payload — because a document that quotes
`ignore your previous instructions` *contains* that string. Excusing it because
of where it lives would be excusing the payload. AC-3 now says a document that
quotes a payload is marked, which is correct, and AC-4 keeps it whole and
findable regardless.

**Two assertions were passing vacuously.** The first version of the AC-6 control
-path test contained literal backspace characters where `\b` was intended, so
three regexes could never match anything. `eslint`'s `no-control-regex` caught
it. Once repaired, the assertions immediately failed — on `array.join()` and
`regexp.exec()`, which are not control paths at all. The property was then
asserted where it is real: on each module's own import list, which is exact.

**One assertion was measuring the wrong thing.** A first attempt asserted that
content-handling modules cannot transitively reach `node:fs` or
`node:child_process`. They can, and it means nothing: `indexing/content.ts`
imports the providers barrel for four *types*, the barrel reaches
`providers/contract.ts`, which reaches `environment/detect.ts`, which runs a
subprocess to describe the machine. The chain is type-level and the scanner
cannot see that `import type` is erased. An assertion that fails for a reason
unrelated to the property it names teaches people to widen it, so it was removed
and the reason recorded in the test file.

## Limitations

- **Containment reduces ambiguity; it does not compel a client.** A model that
  ignores the boundary is outside Ferret's control, and nothing here claims
  otherwise. What changed is that the boundary is now unforgeable and the
  marking is machine-readable, so a client that *wants* to be careful can be.
- **The classifier is a heuristic and will miss things.** It requires an
  imperative aimed at the reader, deliberately, so that it does not fire on prose
  that merely names the topic. An attacker who writes politely will not be
  marked. Containment, not classification, is the control.
- **Classification reads the first 4096 characters of a field.** A payload past
  that is contained but unmarked. Stated rather than hidden — it is a real limit,
  and it exists so cost follows the answer rather than the repository.
- **Containment costs about 9 tokens per contained value**, charged against a
  context pack's budget because the client really does send them. An existing
  test noticed: a pack at a tight budget now trims an item where it used to drop
  one, and reports both omissions.
- **Symbol names and paths are marked but not contained.** Wrapping them would
  break every client that compares `attributes.path` to a file it knows about —
  including Ferret's own dogfooding oracle. An injection needs sentences; a path
  is a token.
- **Nothing is contained at rest.** The store holds exactly what the repository
  holds, so a citation still matches the file. Containment is a property of the
  boundary, and a consumer that reads the database directly gets raw content —
  which is correct, and worth knowing.

## Test inventory

| Suite | Cases | What it proves |
| --- | --- | --- |
| `tests/unit/containment.test.ts` | 30 | The boundary cannot be forged; marking never filters; the attribute policy |
| `tests/unit/boundaries.test.ts` | 7 added | AC-6, on each module's own imports |
| `tests/integration/indexing/hostile-content.test.ts` | 3 | A real hostile repository, end to end through EPIC-108's content stage |
| `tests/integration/mcp/tools.test.ts` | updated | The hostile commit message is contained, marked and still whole |
| `tests/unit/context-pack.test.ts` | updated | The same, for a pack; and the budget change containment caused |
