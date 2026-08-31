# EPIC-041 — Durable Checkpoints

**Priority:** P0  
**Domain:** Session & Agent Memory  
**Status:** IN_PROGRESS

## Outcome

Persist a compact, immutable, provider-neutral checkpoint of a live or recently ended AI session so a later session can resume useful engineering work without replaying the entire captured conversation.

## Dependencies

- EPIC-039 — Session Model
- EPIC-040 — Session Capture
- EPIC-008 — Evidence & Provenance Model

## Scope

- A canonical checkpoint value tied to one session.
- Deterministic identity and content hash.
- Checkpoint sequence and capture watermark so checkpoints can be compared and resumed from safely.
- Compact human-readable summary plus structured continuation state.
- Source references to the latest captured event sequence.
- Immutable values and validation of monotonic checkpoint progression.
- Serialization suitable for durable storage by later storage/integration work.

## Non-scope

- Automatic Claude hook installation or client-specific transport.
- Decision/engineering-memory extraction (EPIC-042).
- Session recovery orchestration (EPIC-043).
- Database tables, retention policy, or encryption implementation; those belong to storage/security Epics.

## Acceptance criteria

1. A checkpoint is explicitly associated with an existing session identifier and provider.
2. Every checkpoint has deterministic identity from session + checkpoint sequence.
3. A checkpoint records the highest captured event sequence represented by the checkpoint; it must be a non-negative integer.
4. Checkpoint progression for one session is monotonic and cannot reuse a sequence number.
5. The checkpoint stores a compact summary and structured continuation state without imposing provider-specific fields.
6. The serialized checkpoint has a stable content hash covering its semantic payload.
7. Checkpoints are immutable after creation; invalid timestamps, sequences, or empty required values are rejected.
8. Tests cover first checkpoint, progression, duplicate/out-of-order boundaries, hashing, serialization, immutability, and invalid input.
9. The implementation remains provider-neutral and introduces no new runtime dependency.
10. Documentation and validation evidence are updated with the implementation.

## Design

The checkpoint is deliberately a **derived, compact state artifact**, not a replacement for raw session capture. Raw capture remains evidence and can be consulted when the checkpoint is insufficient. The checkpoint payload is opaque enough for different AI clients while keeping the identity, ordering, provenance and continuation contract canonical.
