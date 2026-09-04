# Batch 7 — Code-intelligence and identity truth (F-25, F-25b, F-27, F-11)

Branch `forensic/post-roadmap-audit`. Base `0407618`. No change to `main`, no PR, no merge,
no deploy, no Epic touched.

Scope as authorized: **F-25**, **F-25b**, **F-11**, and **F-27** (added to the batch by the
owner after it opened). The final implementation batch.

## 1. Four findings, one sentence

Ferret says what it knows. Each of these is a place where it said something it did not know:

- **F-25** — a member call resolved to a same-file homonym, at the highest confidence band.
- **F-25b** — one call site produced two open intervals, and a deleted call produced none.
- **F-27** — what Ferret refused to resolve was counted, logged, and thrown away.
- **F-11** — two people with no address became one person, irreversibly, at derivation time.

The first three are the call graph; the fourth is the people. Both are answers a human acts
on, and all four fail in the same direction: towards a confident answer Ferret cannot support.

## 2. Failing evidence, before any implementation change

### F-25 — `tests/unit/code-reference-truth.test.ts`

**5 of 9 red.** The resolver refused nothing:

```
refuses a member call on an unknown receiver, however local the homonym
  → a Map.has() call resolved to a same-file declaration:
    expected [ { reference: {…}, …(4) } ] to strictly equal []
refuses it when the receiver is a member expression, not just a bare name  → same
refuses `this.x()` when the homonym belongs to a different declaration     → same
names the receiver for TypeScript  → the Map.has() receiver was not reported: expected undefined
names the receiver for Python      → self.has() was not reported with its receiver
```

Four green throughout, and they are the controls that had to stay green: a bare call still
resolves `same-file`, and a member call still never reaches the repository rule.

### F-25b and F-27 — `tests/integration/indexing/reference-intervals.test.ts`

Real PostgreSQL, real `git`, real grammars, because both findings are about what survives
*between runs* — a fake store would agree with the code rather than with the database, which
is how the duplicate intervals passed their unit tests. **5 of 6 red:**

```
opens one interval when a call moves to a different line
  → moving a call opened a second interval for the same fact:
    expected [ {…}, {…} ] to have a length of 1 but got 2
does not put a line number in the edge’s identity
  → expected [ 'line', 'name', 'rule', …(1) ] to not include 'line'
closes the interval when the call is deleted
  → a deleted call is still asserted: expected [ {…} ] to strictly equal []
records the file’s resolution counts
  → the unresolved count was computed and thrown away: expected undefined to be defined
names the reasons  → expected [] to include 'receiver-unknown'
```

The one green is the control — an unchanged file's edges must not move — and it stayed green
through the fix, which is the assertion that matters most for a sweep that closes things.

### F-11 — `tests/integration/git/identity-collapse.test.ts`

Real `git`, real commits, and the provider's own `emitHistory`, because the identity is
derived there. **2 of 5 red**, and the first one is the finding entire:

```
does not merge two people into one developer — F-11
  → a non-address became a developer identity:
    expected [ 'Carol Chen', 'Bob Brookes' ] to strictly equal [ 'Carol Chen' ]
records what Git said rather than discarding it
  → the author Git reported was dropped without a trace: expected undefined to be defined
```

Three commits by three people — Alice `<unknown>`, Bob `<unknown>`, Carol
`<carol@example.com>` — produced **two** developers. Alice and Bob are one entity, and the
surviving display name is whichever commit Git happened to return last: the "order-dependent
naming" the triage predicted, reproduced exactly.

## 3. The fix

### F-25 — corroboration, not refusal

`resolveReferences` applied `same-file` *before* it checked `reference.qualified`; the guard
§8.3 describes sat only in front of the repository rule, where it never ran for a name the
file also declared. The check moves above the same-file rule.

Refusing every member call was the wrong correction: `this.helper()` is a real edge and is
most of what a call graph inside a class *is*. So the parser now reports the **receiver**
(`CodeReference.receiver`), and `this`/`self` — the one receiver whose type Ferret knows,
because it is the enclosing declaration — corroborates. Everything else, `map.has()` and
`this.#providers.has()` alike, is `receiver-unknown`.

The resolution goes to *that member*, not to the file's only homonym: a file holding
`Registry.has` and `Cache.has` is ambiguous by name and not ambiguous at all for
`this.has()` inside `Registry.check`.

`cls` is deliberately not a self-receiver. A Python classmethod's `cls` is the class *or a
subclass*, and resolving it to the enclosing declaration is the guess this module refuses.

### F-25b — a line is not part of a fact

`line` is gone from the reference edge's metadata. `#findOpenEquivalent` matches on
byte-identical metadata, so with the call site's line in there an edit that moved a call
opened a second open interval for a fact that had not changed. The line is not lost: it is
per *call site*, which is what the evidence row records — `cardinality: 'collection'`, one
row each, with a `line` locator. "`use` references `helper`" is one fact however many times
and wherever it is written.

And the indexer now closes what it did not re-assert. Scoped to the endpoints the content
stage actually re-derived — every file it resolved and every symbol it built, whether or not
they produced an edge, which is the distinction that makes it safe. For a file skipped at the
gate an absent edge means "not looked at"; for one in that set it means the call is gone.
A tombstone, not a delete.

### F-27 — the number that matters is written down

`FileReferenceResolution` — extracted, resolved, and unresolved by reason — is persisted on
the `file` entity, through the same seam `structure` uses. Present only for files this run
resolved, so "not measured" and "measured, nothing unresolved" stay apart.

### F-11 — no address, no identity

`NormalizedIdentity.addressed` says whether the address was one. The opaque form is still
produced, because a `.mailmap` maps exactly these and repairing imported history is what
mailmaps are for — so the refusal happens **after** the mailmap, not before it. The provider
mints no actor for an unaddressed identity, and the commit records
`unattributedAuthor: { name, email, reason }` instead: refusing to identify is not licence to
lose the observation, and a `.mailmap` added later repairs the history from those strings.

## 4. Second-order defects found by re-auditing, and corrected

1. **A second run would have rewritten every gate-skipped file.** The counts go on the `file`
   entity, and an unchanged second run skips the parse at the gate — so the entity was
   re-emitted with no counts, the upsert reported `updated`, and EPIC-108 AC-6's "a second
   run writes no rows" was false for exactly the files the gate exists to make free. The same
   trap `structure` already documents, one attribute later. Fixed the same way: the artefact
   carries the resolution and the gate replays it — which required moving the artefact write
   for a parsed file *after* resolution, since the counts do not exist until then. Pinned by
   its own test.
2. **One database round trip per symbol.** The sweep asked `outgoing()` per endpoint, and on a
   first index of a ten-thousand-symbol repository that is ten thousand queries to learn that
   a symbol created moments ago has nothing to close. Replaced with one chunked
   `openOutgoingOfTypes` query.
3. **The sweep was invisible.** It closed edges and reported nothing, so "closed none" and
   "never ran" were the same observation — the failure this audit has now named five times.
   `IndexReport.referencesRetired` reports it, and the port's optional pair is documented as
   both-or-neither so half of it cannot silently disable the other.
4. **A commit was silently dropped.** The first version of the F-11 fix put
   `unattributedAuthor` on the commit entity without extending the strict attribute schema, so
   `emitHistory` rolled the commit back and the page came up short. Caught because the fixture
   asserts on the emitter's own `skippedRecords` rather than only on a count — added after the
   count-only version reported "expected 3, got 2" and said nothing about why.
5. **Two orphaned doc comments**, from splicing a method into the wrong place: `#contentStage`
   and `resolveReferences` were each left with someone else's documentation above them.
6. **A vacuous assertion in my own fixture.** `expect(identity?.addressed ?? false).toBe(false)`
   passes when the property does not exist, so it was green against the defect it was written
   for. It asserts the value now.

## 5. Paths audited and found sound

- **Other parsers.** Only the code parser emits references, so `receiver` has one producer.
  An external provider (EPIC-074) that supplies a `CodeReference` without one gets every
  qualified reference left unresolved — the safe direction, and the module's own doctrine.
- **Nested functions.** `this.x()` inside a function nested in a method resolves against
  `Registry.check` and finds nothing, so it stays unresolved. Conservative, and correct.
- **The retire sweep's blast radius.** `CONTENT_EDGE_TYPES` is written down and asserted, so a
  content run cannot close a history edge.
- **`emitFiles` remains pure.** Both new options are by path and optional, exactly like
  `structure`; a caller that did not run the content stage supplies neither and emits what it
  emitted before.

## 6. Verification

`lint && typecheck && build && vitest run`: **see §7**. The Batch 7 fixtures are 20 assertions
across three files, all green, each red first for the reason recorded in §2.

**PostgreSQL note.** The container Docker supplies had stopped part-way through this batch,
and the database-backed suites *skip loudly* rather than failing — `[Batch 7] SKIPPING…`. It
was restarted and every figure below was taken with it running. A run that skips them is not
a run that passed them, and the skip line is what makes that visible.

## 7. What this does not claim

- **F-27 persists; it does not yet qualify an answer.** The counts are on the `file` entity
  and reach any caller that reads it. `ferret_neighbours` does **not** yet attach a
  completeness note to a reference query, so "nothing references this" still reads as a bare
  count on that tool. The finding's own remedy has two halves — "persist unresolved counts per
  symbol; emit a `partial:` notice on reference reads" — and this batch delivers the first.
  The second is recorded as remaining work rather than claimed.
- **F-25 resolves fewer references than before, deliberately.** Every edge it now refuses was
  an edge that read as knowledge and was wrong. The count going down is the fix.
- **F-11 loses the developer entity for unaddressed authors.** That is the intent, and the
  commit keeps what Git said. A repository whose entire history is `<unknown>` will have no
  developers and every commit marked unattributed — which is the true answer.
- The retire sweep closes edges only for endpoints a content run re-derived. Edges from a file
  the stage never visits are not swept, and never were.
