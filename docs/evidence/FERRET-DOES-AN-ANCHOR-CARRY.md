# Does an anchor let a fresh agent skip the investigation? — the measurement

**Branch:** `epic-137-code-state-anchors` · **Trees:** Session A and T1 at
`951d957`; the maintenance session and T2–T4 at `1cf247a`; T5 at `e18a5fd` ·
**Model:** `opus`, effort `high`, one repeat ·
**Stores:** `ferret_agent_ab` (benchmark, dropped and rebuilt), `ferret` (dogfood) ·
**Commands:** `node benchmark/agent/anchors.mjs --phase …`, `node .local/dogfood-137.mjs …` ·
**Date:** 2026-09-08

EPIC-137 bound a durable statement to the file content it was observed against.
The question this answers is the one the Epic's §14 named in advance, and it is
answered **no** on the productivity half and **yes** on the safety half.

Correctness evidence is in
[the validation record](../EPICs/validation/EPIC-137-VALIDATION.md). This report
is the productivity and safety measurement, kept separate deliberately.

---

## 1. The answer

> **Does an anchored statement let a fresh agent inherit an engineering finding
> without re-doing the investigation?**

**On this evidence: no.** Across five repository states and ten sessions, the
treatment re-read the anchored files in every one, and spent **1.2× to 2.5× the
control's context** to reach the same answer.

**And it never trusted a stale record.** Zero stale assertions in ten sessions,
zero false drift, and every session reached the correct verdict.

So the mechanism is correct and safe, and it did not save work. The Epic's
mandatory criterion — *"if T1 saves rediscovery but T2 causes stale knowledge to
be trusted, EPIC-137 fails"* — is met in the direction that matters, and the
success criterion it was paired with is not.

---

## 2. What was measured

`benchmark/agent/anchors.mjs`, on `benchmark/agent/lib/*` — the same harness,
session runner, grader and corpus guard the Phase 6 experiment used. One model,
one repository, one variable.

- **Control** — `Read`, `Grep`, `Glob`, `Bash`, no MCP server, plus `HANDOVER.md`
  holding **every statement Session A recorded, verbatim**. The verdict is
  deliberately not written into it: a notes file has no mechanism for saying
  whether the code still matches, and that absence is the capability under test.
- **Treatment** — the same four tools plus every tool Ferret publishes, and the
  same statements reachable through Ferret with their verdicts.

Nothing told either arm the answer. Nothing told the treatment to trust a
verdict. **No anchor and no verdict was synthesised** — the anchors are whatever
Session A chose to pass to `ferret_context_record`, which was the owner's
condition for this experiment.

Session A investigated how verification is decided, recorded what it found, and
five fresh sessions were then asked a question that finding answers.

| Task | Repository state |
| --- | --- |
| T1 | unchanged since A recorded |
| T2 | an anchored file changed and was re-indexed |
| T3 | a maintenance session re-anchored against the new content |
| T4 | an explicit replacement supersedes one statement |
| T5 | an unrelated file changed and was re-indexed |

The corpus guard denied every attempt to read this Epic's specification,
decisions record or registry entry — **four refusals across the two T1
sessions**, two per arm, verified in the kept transcripts. `docs/EPICs/README.md` was
excluded too, because its registry line states the mechanism.

---

## 3. Session A: the surface was discoverable

Unprompted, with nothing pointing at the argument:

| | Session A | maintenance session |
| --- | --- | --- |
| statements recorded | 4 | 5 (merged onto A's) |
| statements **anchored** | **4 of 4** | **5 of 5** |
| facts reached | 3/3 | 3/3 |
| files read | 4 | 4 |
| cost | $1.31, 132 s | $0.84, 123 s |

Every statement carried an anchor set, several spanning three files, and every
one read `verified` immediately after recording. **The `anchors` argument is
discoverable from the tool description alone** — the same result Phase 6 got for
Ferret itself, at the argument level.

The maintenance session is also AC-21 on the real path: the two statements T2 had
made `stale` returned to `verified` against the new bytes, **with no supersession
and no second record**.

---

## 4. Safety — the criterion that had to hold

| Task | Carried verdicts | Stale asserted | False drift |
| --- | --- | --- | --- |
| T1 | 4 × `verified` | 0 | 0 |
| T2 | 2 × `verified`, **2 × `stale`** | **0** | 0 |
| T3 | 5 × `verified` | 0 | 0 |
| T4 | 5 × `verified` (the retired one is not carried) | 0 | 0 |
| T5 | 5 × `verified` | 0 | **0** |

**T2 is the case the Epic exists for.** One real commit to one anchored file
flipped exactly the two statements anchored to it and left the other two
verified. The treatment then verified from source and reached the correct
current answer. Nothing was asserted from the stale record.

**T5 is the mirror failure, and it does not occur.** An unrelated file was
committed and indexed; all five statements stayed `verified`. A mechanism that
drifted on ordinary commits would be theatre, because the agent would verify
every time regardless.

**T4**: `ferret_context_find` carries current context only, so the reading agent
was handed the replacement and never saw the retired statement.

---

## 5. Productivity — where it fails

Per task, treatment against control:

| Task | anchored-file reads | files read | lines read | context tokens | cost |
| --- | --- | --- | --- | --- | --- |
| T1 | 4 ← 5 | 6 ← 6 | 835 ← 854 | **554 k ← 218 k** | $1.02 ← $0.67 |
| T2 | 3 ← 4 | 5 ← 6 | 903 ← 684 | **435 k ← 183 k** | $0.74 ← $0.48 |
| T3 | 3 ← 3 | 5 ← 4 | 825 ← 709 | **529 k ← 231 k** | $0.78 ← $0.61 |
| T4 | 2 ← 2 | 3 ← 5 | 605 ← 641 | **470 k ← 257 k** | $0.71 ← $0.54 |
| T5 | 3 ← 4 | 5 ← 7 | 813 ← 803 | **411 k ← 340 k** | $0.67 ← $0.69 |

**The success criterion required zero anchored-file reads on T1, T3 and T5. The
result is 4, 3 and 3.** Anchored reads fall slightly on three tasks, are level on
two, and never reach zero. Context is higher in the treatment on all five, by
1.2× to 2.5×.

### Why, and it is not "the agent distrusted the verdict"

The pack **did** deliver the verdict. On T1 the treatment's single
`ferret_context_pack` call returned three `verification` blocks, each with
`verdict: "verified"`, the anchor paths, the symbol, and both hashes — quoted
from the transcript:

```
"verification": { "verdict": "verified", "anchors": [ { "path": "src/context/pack.ts",
  "symbol": "ContextPackBuilder.#verificationFor",
  "observedHash": "git-blob:e82fd555…", "currentHash": "git-blob:e82fd555…"
```

**It arrived at tool call 19 of 24.** By then the session had already read
`src/context/code-state.ts` (call 3), `src/cli/commands/mcp.ts` (11),
`src/storage/code-state.ts` (13) and `src/storage/durable-context.ts` (18). The
rediscovery was already paid before Ferret was asked.

Ferret was called **1–3 times** per treatment session, and late. So the finding
is not that a careful agent refuses to trust a verdict it has — Phase 6's §7.4
reading — but that **it does not ask until it has finished investigating**. Those
are different problems with different fixes, and this experiment separates them
for the first time.

The context penalty has a known cause that this Epic did not touch: thirty tool
definitions re-sent every turn, EPIC-136 §2.3, whose mechanism was withdrawn by
owner decision in §4a. Ferret halved nothing here and the tool list cost 1.2–2.5×.

---

## 6. Dogfood — the real product, the real index

`node .local/dogfood-137.mjs`, against the `ferret` store this repository is
indexed into, through a real MCP client. Every case is the product path:
`ferret_context_record` → real anchor resolution → real `file_version` graph →
real `readWorktreeState` → real `trust()`.

| Case | Verdict observed |
| --- | --- |
| clean tree, index at HEAD | `verified`, both hashes equal |
| unrelated files dirty | `verified` — only the anchor set is consulted |
| anchored path locally modified | `unknown`, `anchored-path-modified`, `currentHash` withheld |
| head moved, index behind | `unknown`, `index-does-not-correspond` |
| change committed and re-indexed | `stale`, both hashes named |
| re-recorded against new bytes | `verified`, `outcome: merged`, no supersession |
| explicit replacement | retired → `superseded`, replacement → `verified` |
| anchor naming no indexed file | reported per anchor, `anchor-does-not-resolve` |
| two pre-existing unanchored statements | `unanchored`, distinct from `unknown` |

Four defects were found here and nowhere else — the checkout resolution, the
default-branch comparison, the two open version edges, and a `repository` entity
with no `path`. All four are in the validation record. **`stale` was unreachable
in the real product** until the third of those was fixed, and no unit test could
have shown it.

---

## 7. What this does not license

- **One repeat, one model, one repository, five tasks, ten sessions.** Directions
  and magnitudes, not p-values.
- **The control is not weak.** It holds the same statements as a notes file, so
  this measures Ferret against a disciplined handover, not against forgetting —
  the baseline `FERRET-DOES-CONTEXT-CARRY` established.
- **Both arms carried the knowledge and neither relied on it.** Consistent with
  the continuity benchmark's *"the two were equal by both being ignored."*
- **The store held five statements.** The product claim is about a knowledge base
  months old; nothing here observes one.
- `git log` subjects mention this Epic by name in both arms. Weak signal, equal
  across arms, and noted rather than excluded.
- AC-20 was not measured across store sizes.

## 8. What the evidence establishes

**Proven.**

- An agent anchors what it records, unprompted, 9 of 9 statements across two
  sessions.
- A real commit to a real anchored file flips exactly the statements anchored to
  it, and nothing else — T2 and T5 together.
- Re-anchoring restores `verified` with no supersession and no second record.
- Ten sessions, zero stale assertions, zero false drift, ten correct verdicts.
- `verified` is unreachable without correspondence: matching hashes on a moved
  head report `unknown`, observed in both the integration suite and the dogfood.

**Not proven.**

- That an anchored statement reduces rediscovery. It did not, on any of the five
  tasks, against a notes-file control.
- That the verdict changes agent behaviour at all. It was delivered and read; the
  session had already finished investigating by then.

**The next question, and this experiment is what makes it askable.** The
mechanism is correct and the surface is discoverable, and the saving is lost to
*when* the agent asks. Whether routing a task-shaped question to
`ferret_context_pack` earlier — a prompt, a tool description, a client
convention, or the EPIC-136 §4a decision revisited — recovers it is a product
decision, and it is now one taken against a measurement rather than an intuition.
