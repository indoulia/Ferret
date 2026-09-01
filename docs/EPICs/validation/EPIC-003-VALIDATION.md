# EPIC-003 — Validation Evidence

**Epic:** EPIC-003 — Configuration Engine
**Branch:** `feat/epic-003-configuration-engine`
**Recorded:** 2026-08-30

Evidence for every acceptance criterion and every Definition-of-Done item. No
criterion is marked PASS without a named artefact that demonstrates it.

The Epic specification is unchanged. No criterion was reworded to fit the
implementation.

---

## 1. Acceptance criteria

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| AC-1 | Required bootstrap inputs are database host, port, database, username, password plus optional repository exclusions | **PASS** | `config.test.ts` → "reads the documented bootstrap surface" asserts the whole mandatory surface is those five plus `exclude`. `config-layers.test.ts` → "starts with no configuration at all" proves nothing else is required. `init-cli.test.ts` → "--save" persists exactly those five and then runs with no `FERRET_DATABASE_*` present at all. |
| AC-2 | Safe defaults eliminate unnecessary configuration questions | **PASS** | `parseConfig({})` succeeds and yields `logLevel: warn`, `port: 5432`, `migrate: auto`, empty exclusions and providers. `DEFAULT_EXCLUSIONS` covers `.git`, `node_modules`, build and dependency trees with a stated reason each, so a user never has to configure them (`config-layers.test.ts`, `config-cli-policy.test.ts` → "lists Ferret's defaults alongside the user's own rules"). |
| AC-3 | Configuration precedence is deterministic | **PASS** | `config-layers.test.ts` → "precedence" (6 cases): the Governance §16 ladder is asserted directly; layers resolve identically in every input permutation; repeated resolution of the same layers is byte-identical; nested objects merge rather than replace. |
| AC-4 | Invalid values produce actionable errors | **PASS** | `config.test.ts` (invalid port, bad log level, malformed provider entry), `config-layers.test.ts` → provider id and shape rejection naming the path, `persistence.test.ts` → "validation before activation", `config-cli-reading.test.ts` and `config-cli-writing.test.ts` → exit code 3 with `E_CONFIG_INVALID`. Every error names the offending path and carries remediation. |
| AC-5 | Secrets are redacted from output/logs | **PASS** | `config-cli-secrets.test.ts` (4 cases): a stored password appears in neither stdout nor stderr at `--log-level trace`, in `list`, `get` or human mode, nor in the audit journal — and `[redacted]` *is* present, proving masking rather than absence. `persistence.test.ts` → a rejected value is never echoed. `init-cli.test.ts` → `--save` does not print or journal the password. |
| AC-6 | Configuration changes are validated before activation | **PASS** | `persistence.test.ts` → "validation before activation" (5 cases): an invalid change leaves the stored file byte-identical; an unresolvable secret reference fails *before* any write; a bad path is rejected. The whole merged document is validated, not just the changed key, so one change cannot make the result invalid. |
| AC-7 | Configuration can be queried by the future AI control plane | **PASS** | `ferret config` has eight subcommands, all with `--json`: `list` (with `--explain` origins), `get`, `set`, `unset`, `validate`, `path`, `exclude list/test`, `audit`. `config-cli-journal.test.ts` → "stream discipline" asserts every one emits exactly one parseable JSON document on stdout even at `--log-level trace`. EPIC-066 can wrap these without a second implementation. |
| AC-8 | Repository/session exclusions can be represented without deleting historical evidence | **PASS** | Exclusions are a **pure decision**: `evaluateExclusion` returns which rule matched and why, and there is deliberately no code path that removes anything. Asserted by `config-layers.test.ts` → "never mutates the rules it is given". Every rule carries `effectiveFrom`, so a question about the past is answered as policy stood then — `config-cli-policy.test.ts` → "answers as policy stood at an earlier instant". The CLI states the contract in its own output ("An exclusion governs indexing and retrieval. It never deletes evidence already recorded."). |

**8 / 8 PASS.**

---

## 2. Required tests

The Epic names eight test areas. All eight exist and pass.

| Required test | Status | Location |
| --- | --- | --- |
| Defaults | PASS | `config-layers.test.ts` → "starts with no configuration at all"; default exclusions |
| Precedence | PASS | `config-layers.test.ts` → "precedence" (6 cases), "mutable scopes" (3 cases) |
| Malformed values | PASS | `config.test.ts`, `config-layers.test.ts` → "configuration file parsing" (5 cases) |
| Secret redaction | PASS | `config-cli-secrets.test.ts` (4 cases); `persistence.test.ts` → auditing (2 cases) |
| Persistence | PASS | `persistence.test.ts` → "persistence" (6 cases) |
| Concurrent changes | PASS | `persistence.test.ts` → 8 OS processes writing at once; lock timeout; stale-lock recovery |
| Exclusions | PASS | `config-layers.test.ts` → "exclusions" (9 cases); `config-cli-policy.test.ts` → "exclusions" (4 cases) |
| Invalid provider configuration | PASS | `config-layers.test.ts` → "provider configuration" (4 cases) |

### Coverage beyond the required list

- **Repository trust boundary** — a `.ferret/config.json` may set *only*
  exclusions. `config-cli-policy.test.ts` proves a hostile policy cannot repoint the
  database, change the log level or enable a provider, and that the refusal is
  reported rather than silent.
- **Durability** — atomic write proven by 40 interleaved read/write cycles, a
  killed process leaving the previous file intact, no temporary files left
  behind, and a corrupt file reported rather than partially applied.
- **Secret references** — resolution from environment and file, trailing-newline
  handling, empty-value refusal, and the guarantee that the reference rather
  than the secret is what gets written to disk.
- **Audit journal** — records what changed, by whom and when; never the value of
  a secret nor the previous value of anything; survives a damaged line; and
  never fails the configuration change it is recording.
- **Performance** — read and write budgets asserted (below).

---

## 3. Performance

Configuration is resolved on **every** Ferret invocation, and Governance §3 has
the AI client spawn Ferret per session, so this is startup cost paid every time.
Budgets are regression ceilings asserted by `persistence.test.ts`.

| Measurement | Budget | Notes |
| --- | --- | --- |
| Read the stored configuration (p95 of 100) | 25 ms | Measured well under; the file is small and read once |
| Locked, validated, journalled write (p95 of 20) | 2 000 ms | Includes lock acquisition, whole-document validation, `fsync` and rename |

The two budgets are deliberately very different, and the reason is worth
recording. Reading is on the startup path, is pure CPU and page cache, and
carries the meaningful limit. Writing is dominated by a single `fsync`, whose
cost belongs to the disk: a GitHub Windows runner measured **527 ms p95** where a
local SSD measured well under 100 ms. An initial 250 ms ceiling failed CI on
Windows for that reason alone.

Rather than delete the budget or special-case a platform, it was widened to a
coarse ceiling that still catches an order-of-magnitude regression — re-reading
the journal on every `set`, say — without policing disk latency Ferret does not
control. A budget tight enough to flake is a budget that gets deleted, and then
it catches nothing.

---

## 4. Defects found by these tests, and fixed

### F-1 — A session layer could be mutated through its own result

`MutableConfigSource` copied its fragment shallowly. A caller holding the result
of `read()` could reach into a nested object — `database`, say — and change what
the layer reported next, so configuration could mutate underneath the process
that had already resolved it. Found by `config-layers.test.ts` → "copies on read,
so a caller cannot mutate the layer through its own result". Fixed by deep-copying
on read *and* on write.

### F-2 — The architecture boundary scanner could be fooled by prose

`boundaries.test.ts` walks the import graph to prove `pg`, Drizzle and vendor
packages stay out of the core. Its regex matched English: a doc comment reading
`Distinguishes "absent" from "unreadable"` registered a dependency on a package
called `unreadable`, and a CLI help string ending in the word *from* swallowed
the next several lines as a specifier.

An architectural control a sentence can fool is not a control. Fixed by stripping
comments before scanning and requiring each capture to have the shape of a real
module specifier — which cannot hide a genuine import, since every real specifier
satisfies it. This strengthened a control that EPIC-001 and EPIC-002 both rely on.

---

## 5. Definition of Done

| Item | Status | Evidence |
| --- | --- | --- |
| Schema documented | **PASS** | `README.md` → Configuration; `docs/Architecture/EPIC-003-DECISIONS.md`; every schema field carries a doc comment naming the governance rule it serves. |
| Validation covered | **PASS** | 39 unit cases in `config-layers.test.ts`, 30 in `persistence.test.ts`, 26 end-to-end across `config-cli-reading`, `-writing`, `-secrets`, `-policy` and `-journal` (one file when this Epic was validated; split for suite runtime, cases unchanged). |
| Secrets protected | **PASS** | Redaction asserted at unit, integration and real-process level, on stdout, stderr, the config file and the audit journal. Secret references keep the secret out of the file entirely. |
| Migration path defined | **PASS** | The file carries `version` (`CONFIG_FILE_VERSION = 1`). A bare object is read as version 1, so hand-written files work; a *newer* version is refused with "upgrade Ferret" rather than misread. Tested in `config-layers.test.ts` → "configuration file parsing". |
| Deterministic behaviour proven by tests | **PASS** | `config-layers.test.ts` → "is deterministic" and "applies layers in precedence order regardless of the order they are passed". |

---

## 6. Security

| Concern | Handling |
| --- | --- |
| **Repository content as policy** | A `.ferret/config.json` is committed and shared with everyone who clones the repository, and Ferret indexes repositories it did not write. It may therefore set **only** `exclude`. Exclusion is additive and one-way, so the worst a hostile repository can do is cause less of itself to be indexed. Governance §12 and §16. |
| Secret at rest | The config file is written `0600`. Secret references let a user keep the password out of the file entirely. |
| Secret in transit through output | Redacted by key name *and* by value shape, at the boundary where data leaves the process, so no call site can forget. `config get` on a secret path returns `[redacted]`, so a caller cannot extract a password one path at a time. |
| Audit journal | Records that a secret changed, never what it changed to, and never the previous value of anything. |
| Path handling | Dotted paths are validated; empty and malformed paths are rejected with `E_USAGE`. |
| Denial of service | Lock acquisition is bounded and reports a retryable error; a lock abandoned by a crashed process is broken by age rather than blocking forever. |
| Dependencies | `picomatch@4` added for glob matching (MIT, zero dependencies). `npm audit` reports **0 vulnerabilities**. |

---

## 7. Known limitations

Recorded rather than glossed over, per Governance §6 and AI Development Rule §10.

| Limitation | Impact | Owner |
| --- | --- | --- |
| `0600` is not enforced on Windows: the mode is ignored and the file inherits the directory ACL. | A password stored by `ferret init --save` is protected by the user profile directory's ACL rather than by an explicit mode. **Restated by EPIC-081**: the mode is still not enforced — that is the platform, not Ferret — but `ferret doctor` now reports the protection the file actually has and names the ACL inheritance, rather than logging the mode Ferret requested. | **EPIC-081** — reported, not resolved |
| Credentials are stored in a plain file, not an OS keychain. | `--save` writes the password in cleartext. This is deliberate for now: Governance §3 has the AI client spawn Ferret with an environment Ferret does not control, so an environment-only password would make normal operation impossible. **Restated by EPIC-081**: the `$secret` form is now a registered-resolver seam, so a keychain is a third registration and no schema change — and `--save` no longer destroys a stored reference, which it did. No keychain backend is registered; §16-3 defers the dependency review a native binding needs. | **EPIC-081** — seam delivered, backend deferred |
| The audit journal is a local file, not an event stream, and is never rotated. | A very long-lived installation accumulates an unbounded journal. | **EPIC-085** — Audit Events |
| Repository policy may set only `exclude`. | A repository cannot express any other intent, even a benign one. Widening the allowlist is a security decision, not a convenience one. | EPIC-003 governance, if a need arises |
| No `ferret config edit`, and no schema export for AI clients. | An agent must use `get`/`set` rather than discovering the schema. | **EPIC-066** — MCP Configuration Tools |
| Exclusions are enforced only where they are consulted. | EPIC-003 delivers the model and the evaluator; applying them at discovery and retrieval time is later work. | **EPIC-022**, **EPIC-058** |
| macOS unvalidated. | Inherited from EPIC-001/EPIC-005; no macOS host available. | **EPIC-105** |

## 8. Defects found after validation, and fixed

Appended rather than folded into §1 or §4. Nothing above is rewritten: those
sections record what was true when this Epic was validated, and a validation
document that edited itself whenever a later defect appeared would stop being
evidence of anything. This section is how a post-validation finding is recorded.

### 8.1 A configuration path could address `Object.prototype`

**Found:** 2026-09-01, while assessing EPIC-066 readiness.
**Issue:** [#81](https://github.com/indoulia/Ferret/issues/81).
**Severity:** low as shipped; the fix is what keeps it low.

`parsePath` accepted `__proto__`, `constructor` and `prototype` as segments, and
`setAt` then descended into `Object.prototype` and assigned to it — polluting
every object in the process:

```
parsePath accepted: ["__proto__","polluted"]
Object.prototype.polluted after setAt: "OWNED"
a fresh unrelated object sees it: "OWNED"
serialized document: {"logLevel":"warn"}
```

Every control in this Epic missed it, and each for a defensible reason.
`isRecord(Object.prototype)` is `true` — it *is* an object — so `setAt`'s loop
descended rather than replacing. `JSON.stringify` serializes own enumerable
properties only, so the document written to disk was clean. `validateCandidate`
therefore had nothing to reject. And §2's tests covered the CLI and the
read-modify-write cycle but never `parsePath`, `setAt` or `unsetAt` directly,
which is the gap that let it live.

**Why it was invisible.** This Epic reasoned carefully about hostile input and got
that right: §6 and the repository trust boundary exist because a cloned
repository's `.ferret/config.json` is untrusted, and `filterRepositoryFragment`'s
allowlist refuses `__proto__` correctly today. The hole was in the input nobody
modelled as hostile — an operator's own dotted path string, trusted because only
an operator could supply one. That was true when this Epic shipped. **EPIC-066 is
what makes it false**, by putting the path string in a model's hands, and
EPIC-084's threat model states that indexed content can influence what a model
asks for.

Worth stating because it is easy to assume otherwise: **EPIC-069's confirmation
gate would not have contained this.** The assignment happens inside `setAt`, after
`consume` succeeds, so a confirmation reduces the attack to two calls. A
confirmation is not a substitute for input validation.

**Fix.** `assertAddressable(segments)` in `src/config/store.ts`, called from
`parsePath` — the one place every surface inside Ferret turns a caller's string
into a path — and also from `setAt` and `unsetAt`, which are exported: the
guarantee belongs to the function that does the dangerous thing rather than to the
discipline of whoever calls it. Reuses the three keys and the reasoning from
`FORBIDDEN_KEYS` in `src/providers/sdk/operation.ts`, where EPIC-011 needed them
for a decoded cursor; duplicated rather than imported, because configuration must
not depend on the provider SDK. `E_USAGE`, not `E_CONFIG_INVALID` — the stored
configuration is fine and what arrived was a malformed request.

**Coverage.** `tests/unit/config-path.test.ts`, 13 tests — the first direct
coverage these three helpers have had. Verified by reverting the guard: **7 of 13
fail**, including the `Object.prototype` regression. The converse is asserted too:
`providers.constructorName` and `myPrototype` still parse, so the guard matches
whole segments rather than substrings.

**Siblings checked.** `resolve.ts`'s `assign` has the same shape and is
unreachable — its paths come only from the hardcoded `ENV_BINDINGS` table.
`repository-source.ts` is fed genuinely hostile keys and is safe by allowlist,
confirmed rather than assumed, since `JSON.parse` creates `__proto__` as a real
own property that `Object.entries` does see.

**No acceptance criterion of this Epic changes.** AC-4's claim — invalid values
produce actionable errors — is now true of a case it did not previously cover.
