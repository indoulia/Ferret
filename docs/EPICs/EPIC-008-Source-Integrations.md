# EPIC-008 — Source Integrations

**Status: APPROVED**  
**Priority: P1**  
**Owner: Providers**

## Objective

Connect Ferret to authoritative engineering and project-management systems through independent providers, beginning with Git and GitHub and adding Jira as the first PM integration.

## Outcome

Ferret can correlate source-system information across repositories, commits, branches, pull requests, reviews, issues, releases, and future systems without requiring source-system traversal for every query.

## Initial providers

- Git;
- GitHub;
- Jira.

Future providers may include Slack, CI/CD platforms, additional PM systems, document stores, and other engineering sources.

## Scope

- provider-specific authentication;
- source discovery;
- incremental synchronization;
- webhook/event ingestion where available;
- periodic reconciliation;
- source identity mapping;
- normalization into canonical entities;
- source authority metadata;
- provider health and sync cursors.

## Acceptance criteria

1. Git data can represent repositories, branches, worktrees, commits, and history.
2. GitHub data can represent repositories, PRs, reviews, comments, issues, releases, and relevant relationships.
3. Jira data can represent issues, status history, comments, links, releases/projects, and relevant relationships where available through its API.
4. Source credentials are isolated from indexed knowledge.
5. Sync is incremental and resumable.
6. Webhook-driven updates are reconciled against source state where appropriate.
7. Provider outages do not erase historical knowledge.
8. Cross-source relationships can be represented without source-specific coupling in core.
9. Provider permissions are respected during ingestion and retrieval.

## Non-scope

Provider-specific UI is not required. Configuration should be exposed through the AI control plane.
