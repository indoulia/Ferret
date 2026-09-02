# EPIC-081 — Credential Isolation

**Status: APPROVED | Priority: P0 | Domain: Security & Authorization**

> **Specification note.** Written from the registry entry (`docs/EPICs/README.md:186`,
> Security & Authorization, P0) and from the limitations other documents have
> already parked on this Epic by name — the Windows mode gap and the cleartext
> file (`docs/EPICs/validation/EPIC-003-VALIDATION.md:150-151`,
> `docs/Checkpoints/EPIC-003.md:127-128`, `docs/Architecture/EPIC-003-DECISIONS.md:219-224`),
> the absence of any credential store beyond an environment variable and a file
> (`docs/EPICs/EPIC-015-Provider-Configuration-And-Secrets.md:46`,
> `docs/EPICs/validation/EPIC-015-VALIDATION.md:83-86`), and the fact that
> `ProviderContext.config` is still the whole configuration
> (`docs/EPICs/EPIC-015-Provider-Configuration-And-Secrets.md:48`,
> `docs/EPICs/validation/EPIC-015-VALIDATION.md:57-62`, `src/providers/contract.ts:93-98`).
> EPIC-083 §4 lists credential isolation as explicitly not its own
> (`docs/EPICs/EPIC-083-Authorization-Enforcement.md:94`). Nothing here expands
> those records; §16 names the places where this specification decided something
> they did not.

## 1. Objective

Confine every credential Ferret itself holds — today, only the PostgreSQL
password — to the smallest surface that can still use it: one place at rest, one
holder in the process, and no boundary crossing it does not need.

## 2. Problem, measured

At `594d858`, Ferret's disclosure controls are strong and its *possession*
controls do not exist. Redaction stops a credential being shown. Nothing stops
it being copied.

**The value is a plain string on the shared configuration object.**
`databaseConfigSchema.password` is `z.string().optional()`
(`src/config/schema.ts:32`), and a secret reference is flattened into that string
once, before validation, so no later code sees the indirection
(`src/config/secret-ref.ts:137-158`). Measured:

```
resolveSecrets({ database: { password: { $secret: { env: 'FERRET_PG_PASSWORD' } } } },
               { env: { FERRET_PG_PASSWORD: 'hunter2' } })
=> {"database":{"password":"hunter2"}}
```

**Every provider receives it.** The runtime builds one `ProviderHostContext`
carrying the resolved `config` (`src/runtime/runtime.ts:201-204`) and the contract
declares `readonly config: FerretConfig` (`src/providers/contract.ts:89`). A
parser provider, an MCP provider and a source provider are each handed the
database password they have no use for. The contract comment says so and already
names this Epic (`src/providers/contract.ts:93-98`). EPIC-015 narrowed *options*;
it deliberately did not narrow this
(`docs/EPICs/validation/EPIC-015-VALIDATION.md:57-62`).

**Every Git subprocess receives it.** `runGit` and `runGitBytes` pass
`scrubEnvironment(process.env)` (`src/git/runner.ts:212`, `src/git/runner.ts:311`).
`STRIPPED_ENV` removes nineteen variables (`src/git/runner.ts:73-99`), all of
which redirect Git or name a program for it to run; none is a credential.
`FERRET_DATABASE_PASSWORD` is a real input path (`src/config/resolve.ts:58`).
Measured against the built module:

```
scrubEnvironment({ FERRET_DATABASE_PASSWORD: 'hunter2', GIT_DIR: '/tmp/x' })
=> FERRET_DATABASE_PASSWORD  "hunter2"
   GIT_DIR                   undefined
```

`detectGit` is worse: it passes no `env` at all (`src/environment/detect.ts:49-55`),
so its child inherits the parent environment without even the Git-redirect scrub.

**`ferret init --save` writes the password in cleartext, and destroys the one
mitigation on record.** `--save` reads `context.config.database.password` — the
*resolved* value — and writes it through `ConfigStore.setMany`
(`src/cli/commands/init.ts:88-96`). D-011 accepted cleartext at rest for a reason
that still holds, and offered exactly one escape hatch: store a secret reference
instead (`docs/Architecture/EPIC-003-DECISIONS.md:221-224`, repeated as advice in
`src/cli/commands/init.ts:40-45`). Because the resolved value is what `--save`
writes, following that advice and then running `ferret init --save` replaces the
reference with the literal. The command that documents the mitigation is the
command that removes it.

**The at-rest mode is advisory on the platform this repository is developed on.**
`writeConfigFileAtomically` opens with `0o600` and its own comment records that
Windows ignores the mode and the file inherits the directory ACL
(`src/config/store.ts:133-137`). The journal has the same shape
(`src/config/audit.ts:132`).

**What is already correct, and is not this Epic's to redo.** `describeConfig` is
the only supported way to render configuration and redacts by key name and by
caller-supplied path (`src/config/resolve.ts:237-258`); `redact.ts` redacts by key
name, by value shape and by URI userinfo (`src/errors/redact.ts:18-90`); the audit
journal records that a secret changed and never to what
(`src/config/audit.ts:72-78`); `describeConnection` cannot return the password
(`src/storage/connection.ts:78-86`); the MCP configuration tool refuses a literal
credential as a tool argument and names the reference form instead
(`src/mcp/config-tools.ts:143-164`); a confirmation token binds the true plan and
discloses the redacted one, precisely so two different passwords cannot confirm
each other (`src/authorization/confirmation.ts:133-137`).

The gap is not what Ferret shows. It is what Ferret keeps, and what it hands on.

## 3. Scope

1. **One holder in the process.** A provider receives the configuration it needs
   and not the credential fields it does not. On record:
   `docs/EPICs/EPIC-015-Provider-Configuration-And-Secrets.md:48`,
   `src/providers/contract.ts:93-98`.
2. **A credential source beyond an environment variable and a file.** The
   `$secret` form gains a registered-resolver seam, and an OS keychain backend
   behind it. On record:
   `docs/EPICs/EPIC-015-Provider-Configuration-And-Secrets.md:46`,
   `docs/EPICs/validation/EPIC-015-VALIDATION.md:83-86`,
   `docs/EPICs/validation/EPIC-003-VALIDATION.md:151`.
3. **An at-rest guarantee that holds on Windows**, or an explicit, reported
   refusal to claim one. On record:
   `docs/EPICs/validation/EPIC-003-VALIDATION.md:150`,
   `docs/Checkpoints/EPIC-003.md:127`.
4. **`--save` must not flatten a secret reference.** Not on record as such; it is
   the repair of the mitigation D-011 depends on. Raised in §16-1.
5. **No credential in a subprocess environment.** Not on record; measured in §2
   and raised in §16-2.

## 4. Non-scope

Named so it is not quietly adopted.

- **Secrets in indexed repository content** — EPIC-082, VALIDATED and unchanged.
  The boundary is ingestion versus possession: EPIC-082 stops a credential *found
  in a repository* being written into the index
  (`src/security/secrets.ts:101-121`). EPIC-081 governs the credential *Ferret
  itself holds and uses in order to work*. Neither reads the other's data, and
  nothing here relaxes an exclusion or a redaction EPIC-082 established.
- **Per-provider option validation, `secretOptions`, and redaction by declared
  path** — EPIC-015, VALIDATED. This Epic narrows `ProviderContext.config`, which
  EPIC-015 §4 named as belonging here; it does not revisit `settings`.
- **Deciding who may read a credential** — EPIC-083. Permission and possession are
  different questions;
  `docs/EPICs/EPIC-083-Authorization-Enforcement.md:94` assigns this direction
  here and keeps the other there.
- **Authenticating a principal** — declined by EPIC-068 §4 and again by
  EPIC-083 §4 for a reason that has not changed: Ferret is spawned over stdio and
  there is no channel on which a credential could be presented.
- **Prompt-injection containment** — EPIC-084.
- **Audit events for a credential read, write or resolution** — EPIC-085. The
  existing configuration journal keeps working unchanged.
- **Encrypting the database or its contents at rest** — EPIC-086.
- **Retroactive scrubbing of a configuration file or an index already written** —
  EPIC-090, on the same ground EPIC-082 §4 used to defer it.
  **Answered 2026-09-02:** EPIC-090 §8.7 names export-then-import as the
  mechanism and ships no filter, for Governance §6's reason — an in-place
  rewrite leaves no record that anything was removed.
- **Backup and export of the configuration file** — EPIC-089.
  **Closed 2026-09-02 with nothing built,** and that is the finding: this Epic
  already made the file a portable document. A secret is stored as a reference
  (`{"$secret": {"env": "..."}}`) and resolved once at configuration
  resolution, and the file carries its own `version` envelope, so a document
  Ferret wrote could contain nothing the file does not. Copying it *is* the
  export. `ferret export --backup-command` names the path beside the `pg_dump`
  command so an operator takes both halves. See
  [EPIC-089](EPIC-089-Backup-And-Export.md) §8.4.
- **Credential rotation, expiry, or notifying anyone.** EPIC-082 §4 already
  declined this for Ferret as a product, and no record assigns it to any Epic.
- **Removing the cleartext-file option.** D-011's reason stands: Governance §3
  has an AI client spawn Ferret with an environment Ferret does not control, so a
  credential reachable only through the environment makes normal operation
  impossible (`docs/Architecture/EPIC-003-DECISIONS.md:212-217`). This Epic adds a
  better option; it does not remove the working one.
- **Changing Governance §2's mandatory configuration surface** — host, port,
  database, user, password (`src/config/schema.ts:17-21`). A governance change,
  not an Epic.
- **Zeroing a credential in process memory.** Declined rather than deferred: V8
  strings are immutable and copied by the collector, so the claim would be
  untestable and therefore false. Recorded under AI Development Rule §10.
- **macOS validation** — EPIC-105, inherited
  (`docs/EPICs/validation/EPIC-003-VALIDATION.md:157`).
- **Provider health, restart or failure isolation** — EPIC-014, EPIC-093.

## 5. Inputs

- EPIC-003 configuration engine: precedence, `$secret` resolution
  (`src/config/secret-ref.ts`), the atomic write (`src/config/store.ts:126-158`),
  render-boundary redaction (`src/config/resolve.ts:237-258`), the journal
  (`src/config/audit.ts`).
- EPIC-011/012/013/015: the provider contract
  (`src/providers/contract.ts:88-100`), the registry that derives a per-provider
  context, `ProviderSettings`.
- EPIC-019/020: the Git runner and its existing environment scrub
  (`src/git/runner.ts:73-99`, `src/git/runner.ts:528-541`).
- EPIC-002: `poolConfigFor`, the one legitimate consumer of the password
  (`src/storage/connection.ts:46-76`).
- Governance §2, §3, §5, §12, §16; AI Development Rules §7, §10, §13, §16.

## 6. Outputs

- A narrowed `ProviderContext.config` type, and the projection that produces it.
- A resolver seam in `src/config/secret-ref.ts`, with a keychain-backed `$secret`
  source registered against it.
- A credential-carrying-variable list applied by `scrubEnvironment`, and
  `detectGit` routed through it.
- A `--save` path that preserves a stored secret reference.
- An at-rest report: what protection the configuration file actually has on this
  platform, surfaced through the existing diagnostics.

## 7. Dependencies

**Hard** — EPIC-003 (VALIDATED; every mechanism this Epic narrows), EPIC-011,
EPIC-012, EPIC-013, EPIC-015 (VALIDATED; the per-provider context this extends),
EPIC-019/020 (VALIDATED; the subprocess boundary).

**Not a dependency** — EPIC-082, EPIC-083, EPIC-084. All three are VALIDATED or
IMPLEMENTED, and this Epic composes with them without changing any of their
acceptance criteria.

## 8. Contracts

### 8.1 A credential has one holder

The resolved password is reachable from the storage provider and from nothing
else. Every other consumer of configuration receives a projection with the
credential fields **absent** — absent, not redacted, because a redacted
placeholder is a string that some caller will eventually hand to `pg` and then
spend an afternoon debugging.

`describeConfig` stays exactly as it is. It is the *render* boundary, and it must
keep working for whatever still legitimately holds a credential.

### 8.2 Indirection survives a round trip

A `$secret` reference stored in the configuration file is still a `$secret`
reference after any command that rewrites the file. `ConfigStore` already re-reads
the unresolved document inside the lock (`src/config/store.ts:357-359`), so the
defect is confined to callers that pass a *resolved* value into it — today, one
(`src/cli/commands/init.ts:95`).

**A credential is written only when the user asked for a credential to be
written.** `--save` persists what the user supplied, in the form they supplied it.

### 8.3 A credential source is a resolver, not a special case

`env` and `file` become two registrations against one seam rather than two
branches in one function. A keychain is a third. The object form of `$secret`
already makes this extensible without ambiguity, and the reason is on record: a
string convention such as `"env:VAR"` cannot be distinguished from a literal
password beginning `env:` (`src/config/secret-ref.ts:16-19`).

**A resolver names its source in an error and never its value** — the existing
rule (`src/config/secret-ref.ts:57-64`, `src/config/secret-ref.ts:75-90`),
extended, not replaced.

### 8.4 The subprocess environment is a boundary

`scrubEnvironment` already exists and already carries the right argument:
inherit-then-remove, because a hand-built environment breaks in ways that are
tedious to discover one platform at a time (`src/git/runner.ts:528-535`).
Credential-carrying variables join the removal list. Any Ferret code that starts
a child process uses it, asserted structurally in `tests/unit/boundaries.test.ts`
rather than by review.

### 8.5 An unenforceable guarantee is reported, not claimed

Where `0o600` is not honoured, Ferret states the protection it actually has
rather than logging the mode it requested. Governance §6: represent the unknown
rather than manufacture certainty.

## 9. Acceptance criteria

- **AC-1** A provider's `context.config` contains no credential field. A test
  enumerates the projection and asserts `database.password` is absent, not
  `[redacted]`. *(Record: EPIC-015 §4:48, `src/providers/contract.ts:93-98`.)*
- **AC-2** The storage provider still connects: `poolConfigFor` receives the real
  password through the one path allowed to carry it, proved against real
  PostgreSQL. *(Record: `docs/EPICs/validation/EPIC-015-VALIDATION.md:60-62` — the
  reason EPIC-015 did not do this.)*
- **AC-3** A `$secret` reference stored in the configuration file is still a
  `$secret` reference after `ferret init --save`, and the resolved value never
  appears in the file. *(§16-1.)*
- **AC-4** `--save` with a literal password still writes the literal, unchanged.
  D-011 is preserved, not reversed.
- **AC-5** A third `$secret` source resolves through the seam, and adding it
  requires no change to `databaseConfigSchema`. *(Record: EPIC-015 §4:46.)*
- **AC-6** A reference that cannot be resolved fails configuration resolution with
  `E_CONFIG_INVALID` naming the source and not the value — identical in shape to
  the existing `env` and `file` failures.
- **AC-7** A resolver unavailable on a platform is reported as an unavailable
  *source*, never as an empty password. *(Governance §6, and
  `src/config/secret-ref.ts:21-24`, which already applies this reasoning to an
  unresolvable reference.)*
- **AC-8** `scrubEnvironment` removes every credential-carrying variable, and the
  Git-redirect variables it already removes stay removed; both asserted by test
  over the exported list. *(§16-2.)*
- **AC-9** No child process is started with an unscrubbed environment, asserted in
  `tests/unit/boundaries.test.ts` — which today would fail on
  `src/environment/detect.ts:49-55`. *(§16-2.)*
- **AC-10** On a platform where `0o600` is not enforced, `ferret doctor` reports
  the configuration file's actual protection and names it as a limitation; on a
  platform where it is enforced, it reports that. *(Record:
  `docs/EPICs/validation/EPIC-003-VALIDATION.md:150`,
  `docs/Checkpoints/EPIC-003.md:127`.)*
- **AC-11** No credential value reaches a log line, an error message, an audit
  entry or an MCP response: the existing controls still hold after the narrowing,
  asserted by re-running EPIC-003's and EPIC-015's redaction tests unchanged.
- **AC-12** The limitation rows naming this Epic are resolved, or restated with
  the residue that remains: `docs/EPICs/validation/EPIC-003-VALIDATION.md:150-151`,
  `docs/EPICs/validation/EPIC-015-VALIDATION.md:83-86`.

## 10. Test requirements

- **Unit** — the projection (every credential field absent, every non-credential
  field identical); the resolver registry (registration, unknown source,
  resolution failure, source named and value absent); `scrubEnvironment` over the
  credential list and the existing Git list together; `--save` with a literal,
  with a reference, and with a value supplied only through the environment.
- **Integration, against real PostgreSQL** — the storage provider connects with
  the narrowed context (AC-2); `ferret init --save` round-trips a reference
  (AC-3); `ferret doctor` reports the real at-rest protection (AC-10).
- **Boundary** — AC-9 in `tests/unit/boundaries.test.ts`, alongside the existing
  import-graph assertions.
- **Security** — a provider that reaches for `context.config.database.password`
  fails to compile; a resolver that throws does not fall back to an empty
  password.
- **Platform** — AC-10 is asserted per platform, on the platform, not simulated.
  Windows is where the mode gap is real and is the platform this repository is
  developed on; POSIX enforcement is asserted by mode check.
- **No real credential in the tree**, per EPIC-082's own test rule and
  AI Development Rule §13.

## 11. Security requirements

- **Trust boundaries a credential crosses**, after this Epic: configuration
  source → resolver → the storage provider's pool. Every other edge is closed, and
  closed by construction rather than by redaction.
- **Protected data**: `database.password`, and any value a provider declared
  through EPIC-015 `secretOptions`.
- **Absent beats redacted.** A projection that omits a field cannot leak it
  through a path that forgot to render.
- **Failing closed.** A resolver that cannot produce a value raises; it never
  yields an empty string. `src/config/secret-ref.ts:21-24` gives the reason,
  already tested: an empty password turns a misconfiguration into an
  authentication failure far from its cause.
- **Nothing here weakens EPIC-082, EPIC-083 or EPIC-084.** Redaction, permission
  filtering and containment run where they already run.
- **Recorded plainly:** a credential in a process's memory is readable by anyone
  who can read that process's memory, and a credential in a file is readable by
  anyone who can read that file. This Epic reduces the number of places and the
  number of readers. It does not make the credential secret from the machine's
  administrator, and does not claim to.

## 12. Observability

- `ferret doctor` reports, per credential, which source supplied it — never the
  value, using the existing `describeSecretRef` shape
  (`src/config/secret-ref.ts:57-60`) — and the configuration file's actual at-rest
  protection.
- The startup log already renders redacted configuration
  (`src/runtime/runtime.ts:238`); after the narrowing it renders a projection with
  fewer fields left to redact, which is the observable proof of AC-1.
- A resolver failure is a structured error carrying the source and not the value,
  matching what EPIC-003 already emits.

## 13. Performance constraints

- Resolution stays once per process, at configuration resolution. A keychain read
  is I/O and must be bounded by a timeout; a timeout is a resolution failure
  (AC-6), never a silent empty value.
- The projection is computed once per provider context, not per access.
- `scrubEnvironment` is already called per subprocess; extending the list is a
  longer loop over a fixed, small array.
- No new runtime dependency without a review under AI Development Rule §16 — see
  §16-3.

## 14. Definition of Done

- Every acceptance criterion satisfied; integration criteria against real
  PostgreSQL, platform criteria on a real platform.
- `npm run verify` green on the merge result.
- The two EPIC-003 limitation rows and the two EPIC-015 ones that name this Epic
  updated to what the evidence supports, with any residue restated rather than
  deleted (AI Development Rule §12).
- A validation document at `docs/EPICs/validation/EPIC-081-VALIDATION.md`.
- The registry entry updated to the status the evidence supports.

## 15. Governance alignment

- **§12 Security** — "Security controls are enforced by Ferret, not by AI
  prompts." A provider that never receives a credential cannot forget to protect
  one.
- **§16 Configuration** — the precedence ladder is unchanged; this Epic narrows
  who receives the resolved result, not how it is resolved.
- **§3 AI-Operated by Default** — the reason cleartext at rest was accepted, and
  the reason it is not removed here.
- **§4 Provider-First** — a credential source sits behind a contract, like every
  other external system.
- **§5 Reuse Before Reinvent** — no new cryptography and no hand-rolled keychain
  protocol; the seam exists so a mature implementation can be plugged in.
- **§6 Evidence Before Inference** — an unenforceable at-rest guarantee is
  reported as what it is (AC-10) rather than claimed.
- **AI Development Rules §7** — the scope is the three things on record plus two
  measured defects, and nothing else.
- **AI Development Rules §10** — memory zeroing is declined in §4 with its reason,
  rather than promised.
- **AI Development Rules §13, §16** — no credential in the tree; no dependency
  without review.

## 16. Raised, not absorbed

Three decisions no record dictated.

**16-1 — `ferret init --save` flattening a secret reference is treated as this
Epic's work, not as an EPIC-003 post-validation defect.**
`src/cli/commands/init.ts:95` writes the *resolved* password, so the mitigation
D-011 offers (`docs/Architecture/EPIC-003-DECISIONS.md:221-224`) is destroyed by
the command that recommends it (`src/cli/commands/init.ts:40-45`). EPIC-003 is
VALIDATED and its evidence document has a §8 for exactly this class of finding.
It is claimed here because the fix is the same change as AC-3, and splitting it
would put two Epics in one code path. **If the reviewer prefers, it belongs in
`docs/EPICs/validation/EPIC-003-VALIDATION.md` §8 and AC-3/AC-4 come out.**

**16-2 — Subprocess environment scrubbing is claimed by this Epic, and no record
puts it here.** The measurement in §2 is new: `STRIPPED_ENV`
(`src/git/runner.ts:73-99`) was written to stop Git being redirected, not to stop
a credential leaving, and `FERRET_DATABASE_PASSWORD` (`src/config/resolve.ts:58`)
is in every Git child's environment today. The alternative owner is EPIC-019/020,
which owns the runner. It is claimed here because "credential isolation" names
the property and nothing else does. **AC-8 and AC-9 are the two criteria that
move if the reviewer assigns it to EPIC-019/020.**

**16-3 — An OS keychain backend is scoped, but no library is selected.** Four
records park "OS keychain, vault or credential store" on this Epic, so the
capability is not in doubt; which implementation delivers it is. Ferret's eight
runtime dependencies contain no native module (`@modelcontextprotocol/sdk`,
`commander`, `drizzle-orm`, `pg`, `picomatch`, `pino`, `web-tree-sitter`, `zod`),
a Windows keychain binding generally is one, and AI Development Rule §16 requires
maintenance, licence, security posture and transitive review before a material
addition. This specification therefore commits to the **seam** (AC-5, AC-6, AC-7)
and records that the backend choice needs a dependency review that has not
happened. **If that review rejects every candidate, AC-5 is satisfied by the seam
with `env` and `file` registered against it, and the keychain limitation is
restated rather than closed.**
