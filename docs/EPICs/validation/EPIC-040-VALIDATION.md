# EPIC-040 — Session Capture: validation evidence

**Status: VALIDATED** · domain-only Epic; no database, no provider, no new
runtime dependency.

## What a capture is

One ordered, immutable event of a session — `system`, `user`, `assistant`,
`tool_call` or `tool_result` — identified by `sessionId` + `sequence`. It is
evidence, retained verbatim; EPIC-041 derives the compact form from it.

## Acceptance criteria

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 linked to a session | PASS | `sessionId` required and non-empty; `sessionCaptureKey` is built from it |
| AC-2 deterministic identity | PASS | `creates a deterministic immutable capture`, `distinguishes sequence values within a session` |
| AC-3 kinds constrained | PASS | `accepts %s events` runs once per member of `SessionCaptureKind`; `rejects unknown event kinds and malformed timestamps` |
| AC-4 positive integer sequence, orders within a session | PASS | `rejects zero and fractional sequences`; identity is (session, sequence), so a reused sequence is the same event |
| AC-5 offset-aware timestamps | PASS | `z.iso.datetime({ offset: true })`; malformed input rejected in AC-3's test |
| AC-6 immutable after creation | PASS | `Object.isFrozen` on the capture and on `metadata` |
| AC-7 metadata opaque and neutral | PASS | `preserves provider-neutral metadata without mutating the input object`; `metadata` is `Record<string, unknown>` and nothing in the module names a client |
| AC-8 deterministic Ferret errors | PASS | every rejection throws `FerretError` with `ErrorCode.IDENTITY_INVALID`, details and a remediation |
| AC-9 tests cover the boundaries | PASS | 9 test cases (5 of them the parameterised kinds): creation, every kind, sequence distinction, zero and fractional sequences, unknown kind, malformed timestamp, metadata |
| AC-10 documentation and evidence | PASS | this file; spec and `docs/EPICs/README.md` updated |

## Content hash

`contentHash` covers the event content alone, not the envelope — two events with
identical content in different sessions hash the same, which is what makes
duplicate content detectable across sessions. Identity stays distinct because it
comes from (session, sequence).

## Limitations

- **Nothing persists a capture, and nothing adapts a client to it.** The Claude
  hook, transport and the writer are downstream work; Non-scope says so.
- **`metadata` is `unknown`-valued**, so unlike a checkpoint's continuation
  state it is not constrained to JSON. A caller can put a non-serializable value
  in it and only find out at the storage boundary.
- **Sequence uniqueness is by construction, not enforced.** Creating sequence 1
  twice yields two equal-identity values; rejecting the second is a storage
  constraint.
- **Content is not scanned for secrets here.** EPIC-082 gates the Git provider;
  a session-capture adapter must route through the same detector before any of
  this reaches an index.

## Suite

`58 files, 1071 passed, 288 skipped` with the database suites skipped, which is
the `verify` job's configuration. `npm audit --omit=dev`: 0 vulnerabilities.
