# EPIC-112 — Session Retention & Redaction

**Status:** IMPLEMENTED  
**Priority:** P1  
**Domain:** Storage & Data Lifecycle · Security & Authorization  
**Classification:** HARDENING

## Outcome

Close the two things EPIC-109 to EPIC-111 left open once sessions started
accumulating real rows: nothing could reclaim them, and the path a person types
into did not redact.

## Problem 1 — nothing reclaimed a session

`ferret prune` is the only place Ferret deletes, and EPIC-088's target list
predates the session store by four Epics. A session recorded by `ferret session
start` stayed forever, and so did its transcript, its checkpoints and its
memories. EPIC-109 listed retention as its own non-scope and named this Epic.

## Problem 2 — the explicit memory path did not redact

`memory-extraction.ts` has always redacted before building a memory, and its
comment says why: a secret "is redacted before it becomes a memory rather than
after". The **explicit** path had no such caller.

`createEngineeringMemory` accepted `redactedSecrets` as a caller-reported count
and never called `redactSecrets` itself, so:

```
ferret session remember <id> --kind gotcha \
  --statement "the deploy needs AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCY set"
```

stored the credential verbatim, and `ferret_session_recall` then handed it to an
AI client. The one path a **person** types into was the one path that did not
redact.

This was introduced by EPIC-110 and shipped through EPIC-111. It is recorded
here rather than quietly fixed because the shape of the mistake is the
instructive part: the domain documented an invariant that only one of its two
callers upheld.

## Scope

- `RetentionTarget.SESSIONS` and `RetentionService.#sessions`.
- `ferret prune --sessions --sessions-older-than <days>`.
- Redaction moved into `createEngineeringMemory`.

## Design

**The age is the caller's, and there is no default.** EPIC-088 §8.3 refuses to
invent one, and a memory is the longest-lived thing Ferret records about its own
work. Named separately from `--superseded-older-than` because the two answer
different questions.

**An active session is never eligible, however old.** A session with no
`ended_at` is one nothing has closed, which is not the same as one that is
finished — the distinction EPIC-094 drew for an open run, for the same reason:
age is not evidence that a thing is done. Deleting one would reclaim the context
of work still in progress.

**One table deleted, four reclaimed.** The `ON DELETE CASCADE` in migration
`0015` takes the transcript, the checkpoints and the memories with the session.
The plan says so in a note, because a row count of `1` does not suggest that
three other tables were emptied.

**Redaction belongs in the constructor, not in the callers.** Doing it where the
memory is built is what makes "a memory cannot carry a credential" true of every
caller rather than of the careful ones. It runs *before* truncation, so a secret
straddling the limit cannot survive as a prefix, and *before* the id is derived,
so the identifier is over the text that is actually stored. The caller's count
is added to rather than replaced: extraction redacts first and reports what it
removed, and a second pass over already-redacted text finds nothing more, so a
count it had earned would otherwise be lost.

## Non-scope

**Redacting a transcript.** `session_capture.content` is stored raw, and nothing
writes one — EPIC-110 left capture to the client adapters that will own it.
Redacting a stream nothing produces would be speculative; it belongs with the
capture path, and the Epic that builds that owns it.

## Acceptance criteria

| # | Criterion | Evidence |
| --- | --- | --- |
| 1 | A sessions target exists and reports in the plan | `prune-cli.test.ts` — the target list |
| 2 | An age is required; none is invented | "refuses to choose an age" |
| 3 | Planning deletes nothing | "plans without deleting" |
| 4 | An unclosed session is never eligible, however old | "never touches a session nothing has closed" |
| 5 | A session that ended recently is kept | "keeps a session that ended more recently" |
| 6 | Deletion cascades, and the plan says so | "takes the transcript, the checkpoints and the memories with it" |
| 7 | An explicit memory cannot carry a credential | `engineering-memory.test.ts` — "a memory cannot carry a credential" |
| 8 | A redacted secret does not reappear on recall | `session-cli.test.ts` — "redacts a credential a person pasted" |
| 9 | A count an extracting caller earned survives | "keeps what an extracting caller already removed" |

## Tests

5 integration cases in `retention.test.ts`, 4 unit cases in
`engineering-memory.test.ts`, 1 CLI case in `session-cli.test.ts`, and the
pinned prune target list updated.

## Dependencies

EPIC-109, EPIC-088 (retention), EPIC-082 (secret detection), EPIC-042.

## Definition of done

All acceptance criteria implemented and tested against a real server; the
redaction gap closed at the constructor rather than at one caller; merged
through normal governance.
