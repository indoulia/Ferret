# EPIC-004 — File Intelligence & Indexing

**Status: APPROVED**  
**Priority: P0**  
**Owner: Indexing**

## Objective

Make files first-class knowledge objects and build industry-grade, incremental indexing across source code and common engineering documents without reinventing mature parsers.

## Outcome

Claude can answer file-level and content-level questions directly from Ferret, including questions that require structure such as code symbols, document sections, PDF pages, spreadsheet sheets/cells, tables, formulas, and metadata.

## Scope

- file identity and versioning;
- content hashing and deduplication;
- MIME/type detection;
- parser/provider registry;
- code parsing using mature AST tooling where appropriate;
- PDF, DOCX, XLSX, CSV, Markdown, text, and code support;
- structured extraction;
- chunking and indexing;
- metadata and source locations;
- incremental indexing;
- deletion/tombstone handling;
- parser version tracking;
- indexing status and recovery.

## Reuse requirement

Ferret must use mature parsing libraries and standards. It must not implement proprietary PDF, Office, CSV, or programming-language parsers when suitable maintained implementations exist.

## Acceptance criteria

1. Files are queryable without requiring access to the live repository at query time when indexed evidence is sufficient.
2. Code structure can be represented beyond raw text.
3. PDF page/section provenance is retained where supported.
4. Spreadsheet sheet/cell/table/formula structure is retained where supported.
5. Document metadata and source locations are retained.
6. Unchanged content is skipped during incremental indexing.
7. Duplicate content is deduplicated by stable content identity.
8. Deleted source files are represented without silently confusing stale and current state.
9. Parser failures are isolated, observable, and retryable.
10. Parser behavior is covered by representative fixtures and quality tests.

## Non-scope

This Epic does not define the general retrieval/query planner; it provides high-quality indexed material for retrieval.
