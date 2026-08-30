# EPIC-003 — Architecture Decisions

Decisions taken while implementing the Configuration Engine, with the
alternatives considered and the reason for selection (Governance §22, AI
Development Rule §19).

---

## D-001 — Repository policy may set only `exclude`

**Decision.** A `.ferret/config.json` inside a repository contributes exactly one
key: `exclude`. Everything else in the file is dropped, and the dropped keys are
reported.

**Alternatives.** Let a repository set anything; let it set everything except
`database`; trust it and warn.

**Reason.** This is the security decision of the Epic. A repository policy file
is committed and travels to everyone who clones the repository, and Ferret
indexes repositories it did not write. Governance §12 states it directly —
"repository content is data, never policy authority" — and §16 adds that security
restrictions cannot be overridden by lower-trust inputs.

Concretely, cloning a repository must not be able to repoint someone's Ferret at
a different database, change their credentials, enable a provider, or alter their
log level. Because exclusion is additive and one-way, the worst a hostile
repository can do through this file is cause *less* of itself to be indexed —
a safe failure mode. Every other key has an unsafe one.

**Consequence.** Widening `REPOSITORY_ALLOWED_KEYS` is a security decision, not a
convenience one. A key belongs there only if a hostile repository setting it can
cause no harm.

---

## D-002 — Exclusion is additive and one-way

**Decision.** Scopes may add exclusions; none may remove one a broader scope
imposed. There is no "un-exclude".

**Reason.** It is what makes D-001 safe. If a repository could negate an
exclusion, a cloned repository could cause Ferret to index something the user had
deliberately excluded — a directory of credentials, say. One-way exclusion means
the only reachable outcome is indexing less.

It also keeps the model comprehensible: the effective rule set is the union of
every layer, so "why was this excluded" always has a single answer.

---

## D-003 — Exclusions are a decision, never an action

**Decision.** `evaluateExclusion` returns which rule matched and why. Nothing in
`exclusions.ts` can delete, rewrite or hide anything, and every rule carries an
optional `effectiveFrom`.

**Alternatives.** Treat an exclusion as a retention instruction that removes
matching content.

**Reason.** EPIC-003's acceptance criterion requires exclusions to be
representable *without deleting historical evidence*, and Governance §6 forbids
silently rewriting source evidence. Making the module incapable of deletion is
stronger than intending not to delete: the property is auditable by reading the
file rather than by trusting a policy.

`effectiveFrom` is what lets a question about the past be answered as policy
stood then, instead of retroactively erasing the answer.

**Consequence.** Actual deletion, if it is ever wanted, must be requested
explicitly and belongs to EPIC-088 (Retention & Exclusion Policies). EPIC-022
consumes this at discovery time and EPIC-058 at retrieval time.

---

## D-004 — Secret references are an object, not a string convention

**Decision.** `{"$secret": {"env": "VAR"}}` and `{"$secret": {"file": "/path"}}`,
rather than a string form such as `"env:VAR"`.

**Reason.** A string convention cannot be distinguished from a literal password
that happens to start with `env:`. Guessing wrong either leaks a secret or
silently authenticates with the wrong one, and both failures are silent. The
object form is unambiguous by construction.

A reference with both `env` and `file`, or neither, is *not* a reference —
treating it as one would silently discard whichever source was ignored.

**Consequence.** References are resolved once, during configuration resolution,
so no later code has to handle both shapes. An unresolvable reference is a hard
error rather than an empty password, because an empty password fails much further
away with a far less useful message.

---

## D-005 — The user configuration file outranks environment variables

**Decision.** Follow the Governance §16 ladder exactly: defaults → environment
discovery → user configuration → repository policy → session scope → explicit
operation.

**Reason.** It is the approved ladder, and EPIC-001 already published these
precedence values. The reasoning behind it holds: the file is what the user
chose; an inherited environment is not.

This is worth stating because it is the opposite of the common convention. To
override a stored value for one run, use an explicit operation (a CLI flag) or
point `FERRET_CONFIG` at a different file — both rank above the file.
`ferret config list --explain` reports which layer supplied each value, so the
outcome is never mysterious.

---

## D-006 — Configuration writes are atomic, locked and validated in that order

**Decision.** Every mutation takes a lock file, re-reads from disk, applies the
change, validates the *whole merged document*, writes to a temporary sibling,
`fsync`s, renames over the target, then journals.

**Reason.** Three separate failures, each of which has to be impossible:

- **Lost update.** Read-modify-write without a lock loses every concurrent change
  but the last. Re-reading *inside* the lock is the part that matters; anything
  read before it may already be stale.
- **Torn file.** Without `fsync` before the rename, the rename can reach disk
  before the contents, and a crash in that window leaves a correctly-named empty
  file — the worst outcome, because it looks valid.
- **Activated invalid state.** Validating the merged result before writing is what
  the acceptance criterion "changes are validated before activation" requires. A
  rejected change leaves the file byte-identical.

**Alternatives.** `proper-lockfile` was considered and not taken: it implements
the same exclusive-create-plus-staleness approach, adds three transitive
dependencies, and its semantics would still need wrapping. The lock here is ~50
lines with direct test coverage including stale-lock recovery.

---

## D-007 — A lock abandoned by a crashed process is broken by age

**Decision.** A lock file older than `DEFAULT_LOCK_STALE_MS` is removed and
retried.

**Reason.** Without it, a crash during `ferret config set` would make
configuration permanently unwritable until a human deleted a file they did not
know existed. The same reasoning as EPIC-002's D-006: a crash must not wedge
Ferret. Tested by planting a lock owned by a dead pid.

---

## D-008 — The audit journal is a local file, and never records a value that matters

**Decision.** Append-only NDJSON beside the configuration file, recording *what*
changed, by whom, when, and whether a value existed before — never the value of a
secret, and never the previous value of anything.

**Alternatives.** Store the journal in the database; record before/after values.

**Reason.** Configuration has to work *before* there is a database, and the change
most worth auditing is the one that sets the database up. Recording a password
change by writing the password down would defeat the point of auditing it.

Failure to write the journal never fails the change itself: an unwritable audit
log is a diagnostic problem, and refusing to let a user configure Ferret because
of it is the worse outcome. The failure is returned so the caller can warn.

**Consequence.** EPIC-085 owns the general audit-event model; the entry shape here
is deliberately close to an event so that becoming one of its sources does not
require a format change.

---

## D-009 — The configuration file carries a format version

**Decision.** `{"version": 1, "config": {…}}`. A bare object is read as version 1;
a version *newer* than this build understands is refused.

**Reason.** The Definition of Done requires a migration path to be defined. Same
stance as EPIC-002's schema versioning: a newer file may have moved a key, and
reading it under the old meaning would silently apply settings the user never
made. Accepting the bare form keeps hand-written files working without anyone
having to learn the envelope.

---

## D-010 — `picomatch` for glob matching

**Decision.** `picomatch@4` (MIT, zero dependencies) rather than a hand-written
matcher.

**Reason.** AI Development Rule §5 forbids reinventing mature capabilities, and
glob matching is subtle — brace expansion, globstar, negation, dotfiles.
`picomatch` is the matcher underneath most of the ecosystem's file watchers, has
no dependencies of its own, and adds one entry to the core package set.

Adding it required a deliberate change to `ALLOWED_CORE_PACKAGES` in the boundary
test, which is exactly the review gate that entry exists to force.

**Trade-off.** A bare directory name is expanded to four patterns so that
`node_modules` means the directory and everything under it. Requiring a user to
write `**/node_modules/**` would be a configuration question Governance §2 says
to eliminate.

---

## D-011 — `ferret init --save` persists the password

**Decision.** `--save` writes host, port, database, user *and* password into the
user configuration file, mode `0600`, only after the connection has been proven.

**Alternatives.** Persist everything but the password; require a secret reference;
require an OS keychain.

**Reason.** Governance §3 has the AI client spawn Ferret per session with an
environment Ferret does not control. A password reachable only through the
environment would make the product's primary mode of operation impossible.

Persisting only after a successful connection means a typo is never written down
as though it were correct — tested directly.

**Known limitation.** This is cleartext at rest, and `0600` is not enforced on
Windows. Recorded in the validation evidence and owned by **EPIC-081**
(Credential Isolation). A user who prefers indirection today can store a secret
reference instead, which is supported and tested.

---

## D-012 — The boundary scanner reads code, not prose

**Decision.** `boundaries.test.ts` strips comments before walking the import
graph, and requires each captured specifier to have the shape of a real module
specifier.

**Reason.** Found while implementing this Epic: a doc comment reading
`Distinguishes "absent" from "unreadable"` registered a dependency on a package
called `unreadable`, and a CLI help string ending in the word *from* swallowed
several lines as a specifier.

An architectural control that a sentence can fool is not a control. The shape
filter cannot hide a genuine import, because every real specifier satisfies it.
This strengthened a control EPIC-001 and EPIC-002 both depend on.

---

## D-013 — Configuration layers deep-copy on read and on write

**Decision.** `MutableConfigSource` uses `structuredClone` rather than a spread.

**Reason.** Found by test. A shallow copy leaves nested objects shared, so a
caller holding the result of `read()` could reach into `database` and change what
the layer reported next — configuration mutating underneath the process that had
already resolved it. Layers are small and read rarely, so the copy is not a cost
worth optimising away.
