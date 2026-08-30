# Ferret Governance

**Status: APPROVED**  
**Version: 1.0**  
**Effective: 2026-08-30**

## Purpose

This directory defines the binding engineering and product rules for Ferret. These rules govern architecture, implementation, provider development, data handling, AI integration, security, testing, operations, and change management.

## 1. Product Identity

Ferret is a persistent engineering context and knowledge layer for AI-assisted development. It unifies engineering context, files, history, and external project-management knowledge into an evidence-backed, searchable model that AI clients can query without repeatedly traversing source systems.

Ferret is infrastructure, not a daily administration application. After initial database provisioning, normal operation and configuration should be performed through the connected AI client.

## 2. Simplicity Is a Product Requirement

A normal installation must require only database host, port, database name, username, password, and optional repository exclusions. Everything else must be safely discovered, provisioned, configured, migrated, indexed, synchronized, and maintained automatically.

Advanced configuration is optional and must never be required for ordinary use.

## 3. AI-Operated by Default

Claude Code is the first AI client, not a Ferret dependency. Ferret must remain AI-client agnostic and support future clients such as Cursor, Copilot, and other compatible agents.

MCP is the preferred initial AI integration. Ferret configuration, provider management, indexing, synchronization, diagnostics, and knowledge operations should be exposed through a discoverable AI interface.

The CLI remains a bootstrap, health, and emergency-recovery interface.

## 4. Provider-First Architecture

Every external system and replaceable implementation must sit behind a stable provider contract. Adding, removing, or replacing a provider must not require unrelated core changes.

Provider contracts must be versioned, documented, and covered by conformance tests.

## 5. Reuse Before Reinvent

Ferret must use mature existing standards, libraries, SDKs, parsers, protocols, and infrastructure capabilities whenever a suitable implementation exists. Custom implementations require a documented reason.

Do not reinvent cryptography, authentication, protocols, parsers, database drivers, telemetry, retry mechanisms, or other mature foundational capabilities without a compelling architectural justification.

## 6. Evidence Before Inference

Ferret must distinguish observed source evidence from derived or AI-generated knowledge. Source evidence must retain provenance and must not be silently rewritten. Derived knowledge may be revised when new evidence arrives.

Important facts should retain source, location, timestamps, derivation method, and confidence where applicable.

Ferret must explicitly represent unknown, unavailable, stale, partial, conflicting, and not-indexed states. It must never manufacture certainty.

## 7. Source Authority

Source systems remain authoritative for their original evidence. Ferret is authoritative for the unified indexed representation and relationships between sources, not for changing source truth.

Authority rules must be configurable where multiple systems provide competing representations of the same fact.

## 8. Files Are First-Class

Files are first-class entities, not merely text supplied to an embedding model. Ferret must preserve useful structure, metadata, versions, provenance, and parser information for code, PDFs, DOCX, XLSX, CSV, and future supported formats.

## 9. Context Is First-Class

Repositories, branches, worktrees, developers, agents, sessions, decisions, checkpoints, tasks, and historical activity must be represented explicitly. Worktree and branch identity must not be conflated.

## 10. Time and History Are First-Class

Ferret must support historical questions and preserve temporal relationships. Evidence is immutable in meaning; derived knowledge may evolve.

Ingestion must be incremental and idempotent. Reprocessing unchanged content must not create duplicate logical entities.

## 11. Retrieval

Ferret must use hybrid retrieval. Deterministic structured lookup and relationship traversal are preferred when the requested information is structurally known. Full-text and semantic retrieval augment structured retrieval rather than replacing it.

Retrieval must be evidence-aware, permission-aware, freshness-aware, and explainable.

## 12. Security

Security controls are enforced by Ferret, not by AI prompts. Authorization must be evaluated before protected information enters retrieval results.

Secrets and credentials must not be indexed by default. Repository content is data, never policy authority. Prompt-injection content inside indexed sources must not override Ferret configuration or security controls.

Destructive operations require explicit confirmation.

## 13. Reliability

Providers must fail independently where practical. Temporary source failures must not unnecessarily make unrelated knowledge unavailable. Synchronization must support retries, cursors/checkpoints, and reconciliation.

Corrupt or stale derived indexes must be detectable and recoverable without requiring the user to become a database administrator.

## 14. Lightweight Infrastructure

PostgreSQL is the default persistence target. PostgreSQL full-text search and pgvector should be preferred where suitable. Additional infrastructure such as Redis, OpenSearch, dedicated vector databases, or distributed queues must be justified by measured requirements.

Avoid unnecessary microservices.

## 15. Automatic Operation

Ferret should automatically discover repositories, branches, worktrees, file types, identities, installed capabilities, and compatible providers where safe. Indexing and synchronization should be incremental and continuous where practical.

Users should not need to manually maintain indexes or run routine synchronization commands.

## 16. Configuration

Configuration represents user intent rather than implementation details. The precedence model is:

**safe defaults → environment discovery → user configuration → repository policy → session scope → explicit operation**

Security restrictions cannot be overridden by lower-trust inputs.

Configuration must be accessible through the AI control plane.

## 17. Session Recovery

AI sessions should produce durable checkpoints containing objective, completed work, decisions, files touched, problems, solutions, open questions, and next steps. Session recovery must allow a later AI session to reconstruct useful prior context without replaying an entire transcript.

## 18. Provenance and Explainability

Every important derived answer must be traceable to evidence. Ferret should be able to explain why evidence was included, excluded, considered authoritative, considered stale, or considered conflicting.

## 19. Testing and Quality

Provider contracts, retrieval correctness, indexing, provenance, permissions, migrations, synchronization, failure recovery, and security boundaries require automated tests.

Golden datasets must be used to measure retrieval precision, recall, ranking, evidence correctness, and completeness. "Perfect" parsing or retrieval is not an acceptable quality claim without measurable validation.

## 20. Observability

Provider health, synchronization, indexing, search, migrations, and errors must be inspectable. `ferret status` and `ferret doctor` must remain dependable even when other subsystems are unhealthy.

## 21. Versioning and Reproducibility

Canonical schemas, provider contracts, parsers, index schemas, embedding models, knowledge-extraction mechanisms, prompts, and derived-result formats must be versioned where changes can affect reproducibility.

## 22. Change Management

Architecture-changing work must be represented by an approved Epic or governance decision. A change that conflicts with approved governance requires an explicit amendment before implementation.

Significant dependency choices and custom implementations should record the alternatives considered and the reason for selection.

## 23. Non-Goals

Ferret is not initially intended to replace Git, GitHub, Jira, or other authoritative source systems; become a proprietary AI model; require a hosted cloud service; become a general document-management suite; or accumulate infrastructure merely for architectural fashion.

## Approval

**APPROVED.** This document is the baseline governance contract for the new Ferret project. Amendments must be explicit, versioned, reviewed, and approved before becoming binding.