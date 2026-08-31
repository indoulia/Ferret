# EPIC-040 — Session Capture

**Status:** IN_PROGRESS  
**Priority:** P0  
**Domain:** Session & Agent Memory

## Outcome

Capture provider-neutral AI session events as ordered, immutable evidence linked to the canonical session, so a completed AI context can be retained and indexed without making the core model dependent on Claude or another client.

## Scope

- Ordered session capture events for system, user, assistant, tool-call, and tool-result content.
- Stable event identity derived from session and sequence.
- Monotonic sequence validation and immutable captured values.
- Capture timestamps and source/provider metadata supplied by the adapter.
- Raw event content retained as evidence; derived memory is downstream work.
- Provider-neutral adapter contract; Claude is an adapter target, not a domain dependency.
- Explicit rejection of malformed events and impossible sequence values.

## Non-scope

- Claude hooks, credentials, transport, or client-specific protocol details.
- Durable checkpoint generation (EPIC-041).
- Decision/engineering-memory extraction (EPIC-042).
- Session recovery/context compilation (EPIC-043 and downstream Epics).
- Search, embeddings, ranking, or vectorization.
- Persisting secrets or authentication material.

## Acceptance criteria

1. A capture event can be created and linked to an existing session id.
2. Event identity is deterministic from session id and sequence.
3. Event kinds are constrained to system, user, assistant, tool_call, and tool_result.
4. Sequence numbers are positive integers and uniquely order events within a session.
5. Captured timestamps are valid offset-aware ISO timestamps.
6. Event values are immutable after creation.
7. Provider/client metadata remains opaque and provider-neutral; no Claude-specific types are required by the domain model.
8. Invalid input fails deterministically with Ferret domain errors.
9. Tests cover normal events, every event kind, ordering boundaries, immutability, and invalid input.
10. Documentation records the capture contract and its relationship to session evidence.

## Design notes

Capture is deliberately an evidence envelope, not a summarizer. The raw session remains available for audit/replay while EPIC-041 and EPIC-042 derive compact durable context from it. This separation is what prevents loss of engineering knowledge when an AI context window or client session ends.

## Dependencies

EPIC-039, EPIC-008, EPIC-009, EPIC-010, EPIC-011/012.

## Definition of done

All acceptance criteria are implemented and tested; validation evidence is recorded; documentation is current; no known blocker remains; and the change is merged through normal repository governance.
