# EPIC-066 — MCP Configuration Tools

**Status: IMPLEMENTED | Priority: P0 | Domain: AI Control Plane & MCP**

> **Specification note.** The registry approved this Epic by name, domain and
> priority; no specification was ever written. This document supplies one.
>
> Every acceptance criterion below is derived from something already on record —
> Governance §1, §2, §3 and §16, `validation/EPIC-003-VALIDATION.md` §25 and §154,
> `Checkpoints/EPIC-003.md` §131, `validation/EPIC-009-VALIDATION.md` §115,
> `validation/EPIC-059-061-064-065-VALIDATION.md` §160, and EPIC-068 §4 and
> EPIC-069 §4. **Nothing here invents a requirement.** Where a plausible
> requirement is *not* on record, §4 excludes it and names the owner; where the
> record names this Epic for something that is not configuration, §16 raises it
> rather than absorbing it.
>
> Authored after a readiness review against `4674863`.

## 1. Objective

Let an AI client read, discover, change and check Ferret's configuration through
MCP, so that Governance §1's claim — configuration is performed through the
connected AI client — is true rather than aspirational.

## 2. Value

Governance says this three times, in three different registers.

> §1 — After initial database provisioning, normal operation and **configuration
> should be performed through the connected AI client**.

> §3 — Ferret **configuration**, provider management, indexing, synchronization,
> diagnostics and knowledge operations should be exposed through a discoverable AI
> interface. The CLI remains a bootstrap, health, and emergency-recovery
> interface.

> §16 — Configuration must be **accessible through the AI control plane**.

Today it is not accessible at all. `validation/EPIC-059-061-064-065-VALIDATION.md`
§160 states the position plainly: *"An AI client cannot index, configure or manage
providers — only read."* Every one of the seven MCP tools is read-only, and the
CLI is the only way to change anything — which inverts §3, making the CLI the
primary interface and the AI client the restricted one.

Two more rows are waiting specifically on this Epic.

1. **No schema export.** `validation/EPIC-003-VALIDATION.md` §154 and
   `Checkpoints/EPIC-003.md` §131: *"No `ferret config edit`, and no schema export
   for AI clients. An agent must use `get`/`set` rather than discovering the
   schema."* An agent that cannot discover what is settable guesses, and a guess
   at a configuration key is a failed write at best.

2. **Scope selectors are not persisted.** `validation/EPIC-009-VALIDATION.md`
   §115: *"They are evaluated from whatever a caller supplies. Storing a user's
   scope preferences belongs with configuration or the AI control plane."*

And EPIC-003 already predicted the shape of the answer, which is why this Epic is
small: *"`ferret config` has eight subcommands, all with `--json` … **EPIC-066 can
wrap these without a second implementation**"* (§25). `ConfigStore` already locks,
re-reads, validates, writes atomically and journals. `resolveConfig` already
returns per-path origins. `describeConfig` already redacts. This Epic is a
**surface**, not an implementation, and §8 makes that a contract.

**Both prerequisites now exist.** EPIC-068 §93 built its permission vocabulary so
*"EPIC-066 and EPIC-067 have something to declare"*, and EPIC-069 built the
confirmation a destructive tool must pass. `ferret_config_set` and
`ferret_config_unset` are the first two destructive tools Ferret has ever had, and
they are the reason those Epics came first.

## 3. Scope

- **Reading** the effective configuration, whole or one path at a time, with the
  layer that supplied each value (Governance §16's precedence ladder, made
  visible).
- **Discovering** the schema, so an agent learns what is settable instead of
  guessing — the gap §154 names.
- **Changing** one value, and **removing** one value: `CONFIG_WRITE` plus
  EPIC-069's confirmation, disclosing what would change before it changes.
- **Checking** that the effective configuration is usable, changing nothing.
- **Reading the change journal**, so an agent can see what was changed and when.
- **Reading and testing exclusions**, since an exclusion is the one configuration
  a repository may express and the one most likely to explain a surprising answer.
- **Redaction on every path out**, because configuration is the one part of
  Ferret's model that holds credentials by design.

## 4. Non-scope

Named here so it is not quietly adopted:

- **Health over MCP.** `validation/EPIC-004-VALIDATION.md` §155 names *"EPIC-066,
  EPIC-070"*. It belongs to **EPIC-070** (AI Client Capability Discovery): this
  Epic is *configuration*, and a health report answers *what can this Ferret do
  right now*, which is EPIC-070's question. §16 records the call.
- **Indexing over MCP.** The same §160 row says an AI client *"cannot index,
  configure or manage providers"*. This Epic takes *configure*; EPIC-067 takes
  *providers*; **no approved Epic takes indexing**. §16 raises the ownership gap
  rather than absorbing it.
- **Provider administration** — EPIC-067, which the same row names.
  **Delivered 2026-09-03:** `ferret_providers` and `ferret_provider_recover`.
  Enabling and disabling a provider stays *here* — a second path to
  `providers.<id>.enabled` would be a second set of durability bugs — and
  EPIC-067's remediation for a disabled provider points at `ferret_config_set`
  rather than duplicating it.
- **Interpreting what a permission scope means** — EPIC-083, as EPIC-058 and
  EPIC-068 both already record. This Epic can *store* a scope selector; it does
  not decide what one grants.
- **Granting a permission to itself.** No tool may write `authorization`. §8 makes
  this a contract and §11 says why: a `CONFIG_WRITE` grant that could add
  `MUTATE` to itself is not an authorization model, it is a formality. This is the
  single most important line in the Epic.
- **`ferret config edit`.** §154 names it alongside the schema gap. An editor is a
  human affordance on a terminal; the schema is what an agent needed, and that is
  what this delivers. If a human still wants an editor, it is EPIC-003's.
- **Writing a secret value.** A password must not travel through a tool argument
  into a model's context. §8 requires a secret reference instead, which EPIC-003
  already implements.
- **A repository policy file.** A repository may set only `exclude` (EPIC-003),
  and that boundary is not this Epic's to widen.
- **Multi-value or transactional writes.** One value per confirmation, so what was
  disclosed is what happened.
- **Audit events for a configuration change** — EPIC-085. EPIC-003's journal
  already records one and keeps doing so.
- **Applying a changed configuration to a running server.** A write persists
  immediately and every read tool re-resolves, so an agent always sees its own
  change. But `access` and `principal` are derived once at composition, so a
  changed exclusion or scope reaches *retrieval* only after a restart. Re-deriving
  them per call is EPIC-058's composition to change, not this Epic's. The write
  tool says so in its own response rather than leaving an agent to discover it.

## 5. Inputs

- `ConfigStore`, `resolveConfig`, `describeConfig`, `parsePath`, `getAt`,
  `readAudit`, `evaluateExclusion`, `effectiveExclusions`, `ferretConfigSchema`
  (EPIC-003) — the implementation this Epic wraps rather than repeats.
- `Permission`, `Principal`, `assertPermitted` (EPIC-068).
- `ConfirmationGate`, `OperationPlan`, `EffectChange`,
  `createDestructiveToolGuard`, `CONFIRM_PARAMETER_DESCRIPTION` (EPIC-069).
- `z.toJSONSchema` (zod 4) for the schema export. Governance §5: not reinvented.

## 6. Outputs

- Seven tools on the MCP surface:

  | Tool | Permission | Confirmation |
  | --- | --- | --- |
  | `ferret_config_describe` | `CONFIG_READ` | — |
  | `ferret_config_schema` | `CONFIG_READ` | — |
  | `ferret_config_validate` | `CONFIG_READ` | — |
  | `ferret_config_audit` | `CONFIG_READ` | — |
  | `ferret_config_exclusions` | `CONFIG_READ` | — |
  | `ferret_config_set` | `CONFIG_WRITE` | **required** |
  | `ferret_config_unset` | `CONFIG_WRITE` | **required** |

- `src/mcp/config-tools.ts` and `registerConfigTools`.
- `McpServerDependencies.configuration` — the seam EPIC-069 deliberately declined
  to add before a tool needed it.

## 7. Dependencies

| Epic | Status | What is needed |
| --- | --- | --- |
| EPIC-003 Configuration Engine | VALIDATED | the whole implementation this wraps |
| EPIC-064/065 MCP | VALIDATED | the surface |
| EPIC-068 AI Authorization Model | IMPLEMENTED | `CONFIG_READ`, `CONFIG_WRITE` |
| EPIC-069 Destructive Operation Confirmation | IMPLEMENTED | the confirmation a write must pass |

No external dependency. No new package. No schema change.

## 8. Contracts

Other Epics may rely on the following.

- **One implementation, wrapped.** Every write goes through `ConfigStore`, so the
  lock, the re-read, the validation, the atomic write and the journal apply
  identically to a change made by an AI client and one made by `ferret config`.
  A second write path would be a second set of durability bugs.
- **`authorization` is not writable through this surface.** Refused by path, at
  the tool, before the plan is built. A caller granted `CONFIG_WRITE` cannot grant
  itself `MUTATE`, cannot widen `permittedScopes`, and cannot change
  `principalId`. Governance §16: *"Security restrictions cannot be overridden by
  lower-trust inputs."*
- **No write completes on one call.** EPIC-069's contract, inherited: the first
  call discloses a plan and changes nothing.
- **A secret value is never accepted or returned.** A write to a secret-named path
  is refused with the secret-reference form to use instead; a read returns
  `[redacted]`. EPIC-003's `describeConfig` and `auditValue` are the redactors, so
  there is no second redaction policy to drift.
- **A read reports precedence.** A value and its originating layer, because
  Governance §16 makes precedence the model and a value without its origin cannot
  be reasoned about — an agent that cannot see a value came from the environment
  will keep writing a file that never wins.
- **The schema is generated, never maintained.** Derived from `ferretConfigSchema`
  at call time, so a schema export cannot describe a configuration Ferret no
  longer accepts.
- **A refusal is an error, not an empty result.** `NOT_PERMITTED`,
  `CONFIRMATION_REQUIRED`, `CONFIRMATION_INVALID`, `USAGE` and `CONFIG_INVALID`
  reach the client as codes it can branch on.
- **A rejected change leaves the file byte-identical.** EPIC-003's guarantee,
  restated because this surface is the one that will exercise it most.

## 9. Acceptance criteria

| # | Criterion | Derived from |
| --- | --- | --- |
| AC-1 | An AI client can read the effective configuration, redacted, with the layer that supplied each value. | Gov §16; §25 |
| AC-2 | An AI client can read one value by dotted path, with its origin. | §25 |
| AC-3 | An AI client can discover the configuration schema rather than guessing what is settable. | §154; Checkpoints §131 |
| AC-4 | An AI client can change one value, and the change persists and takes effect. | Gov §1, §3 |
| AC-5 | An AI client can remove one value, restoring its default. | §25 |
| AC-6 | A write requires `CONFIG_WRITE`; a read requires `CONFIG_READ`; the anonymous principal can do neither. | EPIC-068 §8 |
| AC-7 | A write refuses its first call, discloses a plan naming the path and what would replace what, and completes only on confirmation. | EPIC-069 §8; Gov §12 |
| AC-8 | No tool can write any `authorization` path. | Gov §16; EPIC-068 §8 |
| AC-9 | A secret value is never returned, and never accepted as a literal. | Gov §12; EPIC-003 AC-5 |
| AC-10 | An invalid value is refused, and the stored file is unchanged. | EPIC-003 AC-4 |
| AC-11 | An AI client can check that the effective configuration is usable, changing nothing. | §25 |
| AC-12 | An AI client can read the change journal. | §25 |
| AC-13 | An AI client can list exclusions and test a path against them. | §25 |
| AC-14 | A scope selector written through this surface is persisted and reaches EPIC-058's access context. | §115 |
| AC-15 | Every write goes through `ConfigStore`, so locking, validation, atomicity and journalling are not reimplemented. | §25; §8 |
| AC-16 | A configuration path cannot address object internals. | issue #81 |

## 10. Test requirements

**Unit.** The plan a write builds: `SET` when nothing was there and `OVERWRITE`
when something was, the path and both values, and a secret path disclosing a
redaction. The `authorization` refusal, by path and by prefix. The schema export
naming the settable keys.

**Integration.** Through the real MCP protocol: each read tool; a write refused,
disclosed, confirmed and persisted; a removal; an invalid value leaving the file
untouched; `authorization.permissions` refused; a secret path refused with the
reference form; the anonymous principal refused on every tool.

**Failure.** A malformed path, an unknown path, a path addressing object
internals, a write to a read-only file, and a journal that does not exist yet must
each be refused or reported rather than throwing from inside a handler.

**Security.** A `CONFIG_WRITE` grant cannot reach `authorization`; a confirmation
issued for one path cannot write another (EPIC-069's binding, exercised on a real
tool); a stored password is not returned by any of the five read tools; a refusal
carries no credential.

**Architecture.** `tests/unit/mcp-destructive-tools.test.ts`, extended to scan
every module in `src/mcp/` rather than `server.ts` alone — otherwise the control
EPIC-069 built would stop covering the surface at exactly the moment the surface
grew its first destructive tool.

**End to end.** Over real stdio against a real index, since that is the only
configuration a real AI client runs.

## 11. Security requirements

- **`authorization` is unwritable here.** The one rule that makes the rest of the
  authorization model mean anything. Refused by path prefix, before a plan is
  built, so a denied caller learns nothing about the grant either.
- A secret is never accepted as a literal and never returned. The secret-reference
  form keeps the value out of the model's context entirely.
- Every value crossing to a client passes EPIC-003's redactors; there is no second
  policy.
- A configuration path is validated by `parsePath`, which since issue #81 refuses
  segments that address object internals. This surface is the reason that matters:
  the path is a string a model chooses.
- Every refusal goes through EPIC-009's serializer.

## 12. Observability

- A write is loggable with the path and the principal — never the value.
- EPIC-003's journal records every change, and `ferret_config_audit` is how an
  agent reads back what it did.

## 13. Performance constraints

- A read is a resolve and a redact; no query. A write is EPIC-003's existing
  locked write, whose cost EPIC-003 already measured.
- The schema is generated per call; it is small and bounded by the schema itself.

## 14. Definition of Done

- Scope implemented; every acceptance criterion classified with evidence.
- Unit, integration, failure, security and architecture tests pass; the regression
  suite passes.
- `docs/EPICs/validation/EPIC-066-VALIDATION.md` records the evidence.
- Registry entry updated, and the four rows this closes are named.
- EPIC-069's AC-11 caveat is closed and said to be closed.
- No acceptance criterion of any other Epic changed.

## 15. Governance alignment

- **§1, §3, §16** — configuration through the AI client, discoverable, accessible
  through the control plane. This Epic exists for those three sentences.
- **§12 Security** — a destructive change requires confirmation; the grant cannot
  widen itself; secrets do not travel.
- **§2 Simplicity** — five reads, two writes. Nothing to configure in order to
  configure.
- **§5 Reuse Before Reinvent** — the strongest instance in the project so far:
  EPIC-003's engine is wrapped, not repeated, and §8 makes that a contract rather
  than an intention.
- **§6 Evidence Before Inference** — a value is reported with the layer that
  supplied it; a plan states what *would* change.

## 16. Raised for governance

**Health over MCP is EPIC-070's, not this Epic's.**
`validation/EPIC-004-VALIDATION.md` §155 names *"EPIC-066, EPIC-070"* for it, so a
choice was required. This Epic is configuration — what Ferret has been *told* to
do. A health report is what Ferret can *do right now*, which is the question
EPIC-070 (AI Client Capability Discovery) exists to answer — **and answered on
2026-09-03 with `ferret_health`.** Putting it here would
make "MCP Configuration Tools" the home for anything structured that has nowhere
else to go. The row stays open against EPIC-070.

**Nothing owns indexing over MCP.**
`validation/EPIC-059-061-064-065-VALIDATION.md` §160 says an AI client *"cannot
index, configure or manage providers"* and names EPIC-066, EPIC-067 and EPIC-069.
This Epic takes *configure*. EPIC-067 takes *providers*. EPIC-069 supplied the
confirmation. **No approved Epic takes indexing**, and `src/mcp/server.ts` still
says *"Indexing is a command a human runs."* Governance §3 lists indexing among
what should be exposed, and §15 wants indexing continuous and automatic — which
may mean the real owner is EPIC-032 (Index Lifecycle) rather than an MCP Epic at
all. Raised rather than absorbed: an indexing tool would need `INDEX` and a
confirmation, both of which now exist, so the gap is ownership and not capability.

**`CONFIG_READ` is not granted by default.** EPIC-068 grants only `READ` to the
anonymous principal, so out of the box an AI client can read knowledge and not
configuration. Left as it is, deliberately: configuration holds credentials by
design, and `READ` was defended on the grounds that everything Ferret indexes
today is source the caller could read with `cat` — which is not true of a stored
password. The cost is that a default installation must be granted `config.read`
before an agent can help with configuration, and that is the right default for
the thing that holds the secrets.
