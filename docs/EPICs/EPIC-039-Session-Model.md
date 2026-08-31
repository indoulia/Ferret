# EPIC-039 — Session Model

**Status:** VALIDATED — [evidence](validation/EPIC-039-VALIDATION.md)  
**Priority:** P0  
**Domain:** Session & Agent Memory

## Outcome

Define the canonical, provider-neutral identity and lifecycle model for an AI engineering session so later capture, checkpoint, memory, and recovery capabilities can persist and retrieve useful context without treating a transcript as an unstructured blob.

## Scope

- Session identity and stable session key.
- AI-client/provider identity and actor identity.
- Repository/worktree/branch scope when known.
- Session lifecycle: active, completed, abandoned.
- Start/end timestamps and last activity.
- Optional parent/continuation relationship to another session.
- Strict validation and immutable domain values.
- Deterministic canonical identifiers.

## Non-scope

- Capturing provider transcripts (EPIC-040).
- Durable checkpoint creation (EPIC-041).
- Extracting decisions/engineering memory (EPIC-042).
- Recovery/context compilation (EPIC-043 and downstream context Epics).
- Provider-specific hooks or transport protocols.
- Storing secrets or authentication material.

## Acceptance criteria

1. A valid session can be created with a stable canonical identifier and provider-neutral fields.
2. Session identity distinguishes an AI session from the human/agent actor operating it.
3. Repository, worktree, branch, and continuation scope are optional and never fabricated.
4. Lifecycle values are constrained to active, completed, or abandoned.
5. Start time is required; end time is present only after terminal transition.
6. Terminal transitions are monotonic; an ended session cannot become active again.
7. Invalid input and impossible transitions fail deterministically with Ferret domain errors.
8. The model contains no transcript contents, credentials, or provider-specific capture implementation.
9. Unit tests cover normal creation, optional scope, lifecycle transitions, continuation, and invalid/boundary inputs.
10. Documentation records the model and evidence used to validate it.

## Design notes

The raw provider transcript will be evidence in EPIC-040, while this model is the stable identity envelope around that evidence. Derived memory must be traceable back to the session/evidence rather than replacing it. Claude is the first client adapter target, but the model is intentionally not Claude-specific.

## Dependencies

EPIC-006, EPIC-007, EPIC-008, EPIC-009, EPIC-010, EPIC-011/012.

## Definition of done

All acceptance criteria are implemented and tested; validation evidence is recorded; documentation is current; no known blocker remains; and the change is merged through normal repository governance.