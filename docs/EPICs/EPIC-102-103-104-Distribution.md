# EPIC-102 — NPM Distribution · EPIC-103 — Global CLI · EPIC-104 — AI Client Onboarding

**Status: APPROVED | Priority: P0 (all three)**

> **Specification note.** Three registry entries, one document: they describe one
> journey — publish, install, use. Elaborated to the
> [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md) from the approved
> registry entries and Governance §15, §21 and §22. Each keeps its own criteria.

## 1. Objective

Make Ferret usable by someone who did not build it.

## 2. Value

Ferret works. It indexes, answers and serves an AI client — and none of that
matters to anybody who cannot install it and wire it up.

Two failures dominate distribution, and neither announces itself.

**The artefact and the source disagree.** `npm pack` and `npm publish` ship
whatever happens to be in `dist/`. Nothing rebuilds it, so publishing from a
checkout whose last build predates its last edit ships code that exists nowhere
in the repository — and the published version and the tagged commit differ with
no way to tell.

**The documentation drifts.** The README is the first thing anyone reads and the
last thing anyone updates. Its command table said `ferret mcp` was *planned* for
two Epics after it shipped. A README that lies costs the reader the time to find
out, which is worse than one that says nothing.

## 3. Scope

- **EPIC-102:** a tarball that always matches its source; a published file list
  that cannot leak; subpath exports that keep the architecture's boundaries.
- **EPIC-103:** a global install that produces a working `ferret` binary.
- **EPIC-104:** onboarding — how to index, how to connect an AI client, what the
  client can then do, and what Ferret does and does not promise about the
  content it returns.

## 4. Non-scope

- Cross-platform packaging beyond Node's own reach (EPIC-105).
- Upgrade and migration UX (EPIC-106).
- Docker images (EPIC-107).
- Registry publication itself, which is a release action rather than a build
  artefact.

## 5. Inputs

Everything EPIC-001 through EPIC-065 built.

## 6. Outputs

A `prepack` guarantee, an onboarding section in the README, and assertions that
keep both true.

## 7. Dependencies

All prior Epics.

## 8. Contracts

### The tarball is rebuilt at pack time

`prepack` runs for `npm pack` and `npm publish` and **not** for a consumer's
`npm install`, which is exactly the boundary where the guarantee is needed and
exactly where it costs nothing.

It has one consequence worth knowing: `prepack` cleans `dist/`, so a test suite
that packs while other tests execute from `dist/` will delete the build out from
under them. Ferret's packaging tests therefore pack with `--ignore-scripts`, and
the existence of `prepack` is asserted separately.

### The documentation is checked, not trusted

Prose is not asserted. What is asserted is the handful of facts derivable from
the code that would otherwise drift: every shipped command appears in the
README, no shipped command is described as planned, the MCP configuration is
present, and every tool is named.

## 9. Acceptance criteria

### EPIC-102 — NPM Distribution

- **AC-1** The tarball is rebuilt from source at pack time.
- **AC-2** Only `dist`, `README.md` and `LICENSE` are published.
- **AC-3** The subpath exports the architecture depends on are published.
- **AC-4** The required Node version is declared.
- **AC-5** Packing twice yields byte-identical tarballs.

### EPIC-103 — Global CLI

- **AC-6** `npm install -g` produces a working `ferret` on `PATH`.
- **AC-7** The entry point carries a shebang.
- **AC-8** The installed binary reports its version and its commands.

### EPIC-104 — AI Client Onboarding

- **AC-9** Every shipped command is documented.
- **AC-10** No shipped command is described as planned.
- **AC-11** Connecting an AI client is documented with working configuration.
- **AC-12** Every MCP tool is named with what it answers.
- **AC-13** The README states that returned content is data, not instructions.

## 10. Test requirements

- **Integration:** pack, install into a clean project, install globally, and run
  the binary — which `packaging.test.ts` already does end to end.
- **Distribution:** the derivable README facts, and the packaging guarantees.
- **Post-deployment:** the installed binary indexes a real repository and serves
  MCP over stdio.

## 11. Security requirements

`files` is what stops a `.env`, a fixture or a scratch directory reaching a
public registry, and it is asserted exactly rather than loosely. The packaging
suite already scans every shipped file for credential-shaped strings.

## 12. Observability

`ferret status` and `ferret doctor` are the documented first steps after
install, because "it does not work" should be answerable without reading source.

## 13. Performance constraints

The package stays under the size backstop EPIC-018 widened, which exists to
catch leakage rather than to police growth.

## 14. Definition of Done

Criteria evidenced, and the installed artefact demonstrated indexing and serving.

## 15. Governance alignment

- **§15 Automatic operation** — install, `init`, `index`, connect; no ceremony.
- **§21 Versioning** — the artefact matches the commit it was built from.
- **§22 Change management** — the README cannot silently stop being true.
