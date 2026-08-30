# EPIC-005 — Engineering Context & Sessions

**Status: APPROVED**  
**Priority: P0**  
**Owner: Context**

## Objective

Persist the engineering context surrounding AI work so that future sessions can understand what developers and agents did, decided, changed, and left unfinished.

## Outcome

Ferret understands repositories, branches, worktrees, developers, agents, sessions, decisions, files touched, commands/events, problems, solutions, and checkpoints as related historical context.

## Scope

- repository discovery;
- branch identity;
- worktree identity;
- developer identity reconciliation;
- AI agent identity;
- session lifecycle;
- session-to-repository/worktree relationships;
- durable checkpoints;
- decisions and assumptions;
- files touched;
- open questions and next steps;
- historical session retrieval;
- automatic context capture where safely available.

## Acceptance criteria

1. Current repository, branch, worktree, developer, agent, and session context can be represented independently.
2. A later AI session can retrieve a useful checkpoint without replaying the entire prior transcript.
3. Important decisions can be linked to the session and supporting evidence.
4. Session history is immutable as evidence while derived summaries may evolve.
5. Session capture does not require users to manually run routine save commands.
6. Scope and retention policies can exclude sessions or repositories.
7. Historical session queries identify when information was observed.

## Non-scope

This Epic does not define the AI-specific conversation UI or replace the AI client's own transcript storage.
