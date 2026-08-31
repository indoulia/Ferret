# EPIC-036 — Developer Identity

**Status: VALIDATED | Priority: P0** — [evidence](validation/EPIC-036-VALIDATION.md)

> **Specification note.** Authored from the approved registry entry and
> Governance §5, §6, §9, §12 and §22, following the Epic Specification Standard.
> Cross-source resolution — a GitHub login to a Jira account — is EPIC-051 and
> is not implemented here. `attributes.ts` already names this Epic as the one
> that resolves a developer's addresses.

## 1. Objective

Turn the identities a Git repository records into the right *kind* of actor,
normalized, with the same person's addresses proposed for resolution rather than
merged on a guess.

## 2. Value

Today every commit author becomes a `developer` keyed on a lowercased email.
Three things are wrong with that, and each is wrong in a way that is invisible
until someone acts on the answer.

**Bots are people.** `dependabot[bot]`, `github-actions[bot]` and every CI
service account are recorded as human contributors. "Who has worked on this
file" then answers with a machine, and EPIC-009 made developer and agent
distinct identity classes precisely so that would not happen.

**The same person is several people.** One contributor commits from a laptop as
`ada@example.com`, from CI as `ada@users.noreply.github.com`, and from a fork as
`ada.lovelace@personal.example`. Ferret holds three developers, each with a third
of the history, and every "who knows this code" answer is wrong.

**Git already knows the answer and nobody asked it.** `.mailmap` is Git's own
authoritative mapping, maintained by the project, honoured by `git log` and
`git shortlog`. Reading it is the difference between reconciliation as a guess
and reconciliation as a recorded fact.

## 3. Scope

- normalizing a Git identity: address casing, whitespace, plus-addressing;
- recognising GitHub `noreply` addresses and recovering the login from them;
- classifying an identity as a person or a non-human actor, with a reason;
- reading `.mailmap` and applying it, because it is the project's own answer;
- proposing resolution candidates for identities `.mailmap` does not cover, each
  with a confidence and the evidence for it;
- emitting the right entity kind — `developer` or `agent` — from the Git
  provider, replacing today's "every author is a developer";
- an `agent_authored_commit` relationship, because `developer_authored_commit`
  accepts only a developer and widening it would make EPIC-009's distinction
  unqueryable.

## 4. Non-scope

- cross-source resolution: a GitHub login to a Jira account — EPIC-051;
- performing a merge. This Epic *proposes*; EPIC-009's `IdentityStore.merge` is
  the only thing that merges, and it requires evidence.
- guessing from a display name alone. Two people called "admin" are two people.
- organisational data: teams, managers, employment. Ferret indexes a repository,
  not a directory.
- ranking contributors, or any measure of who "owns" a file — EPIC-057.

## 5. Inputs

- EPIC-019's commit records: author and committer name and address;
- EPIC-009's actor model, alias store and collision detection;
- a repository's `.mailmap`, when it has one;
- EPIC-006 `developer` and `agent` attributes.

## 6. Outputs

- `normalizeGitIdentity(name, email)` returning a normalized identity;
- `classifyIdentity(...)` returning `developer` or `agent` and the reason;
- `parseMailmap(text)` and `applyMailmap(map, identity)`;
- `proposeIdentityLinks(identities)` returning candidates with confidence;
- Git provider emission that produces `agent` entities for non-human actors.

## 7. Dependencies

EPIC-006, EPIC-009, EPIC-019, EPIC-020.

## 8. Contracts

### An address is the identity; a name never is

Two people called "admin" are two people. A display name contributes to a
*candidate*, never to identity, and an identity with no address is not recorded
at all — inventing one from a name would merge every unattributed author in a
repository into one person.

### `.mailmap` is authoritative; everything else is a proposal

The project's own mapping is applied directly, because it is a maintained
statement by the people who know. Every other signal produces a candidate with a
confidence and a reason, and something else decides. Governance §6 forbids
manufacturing certainty, and identity is where a manufactured certainty does the
most damage.

### A candidate carries its evidence

Every proposal names the rule that produced it — `mailmap`, `same-address`,
`github-noreply-login`, `same-name-and-local-part` — and a confidence. A
reviewer, human or AI, sees why, and a rule that turns out to be bad is
identifiable in what it already produced.

### Bot classification is by pattern, and is conservative

`[bot]` suffixes, known service addresses and the GitHub Apps noreply form are
recognised. Anything unrecognised is a person. Misclassifying a person as a bot
removes them from "who wrote this", which is worse than the reverse.

### Plus-addressing is normalized, subaddressing is not assumed

`ada+ferret@example.com` and `ada@example.com` are the same mailbox by RFC 5233
convention at every major provider, so the tag is stripped for *comparison* and
the address is retained verbatim as evidence.

## 9. Acceptance criteria

- **AC-1** An address is lowercased and trimmed, and the original is retained.
- **AC-2** A GitHub noreply address yields the login, and the numeric id prefix
  does not become part of it.
- **AC-3** An identity with no address is refused, not invented.
- **AC-4** `[bot]` suffixes, GitHub Apps noreply addresses and known CI service
  accounts classify as `agent`; an ordinary contributor classifies as
  `developer`.
- **AC-5** Every classification carries the reason that decided it.
- **AC-6** `.mailmap` parses in all four forms Git defines, and comments and
  blank lines are ignored.
- **AC-7** A `.mailmap` entry rewrites the identity it names, and leaves others
  untouched.
- **AC-8** Two identities sharing a normalized address propose a link at high
  confidence; two sharing only a display name do not propose one at all.
- **AC-9** A noreply login matching another identity's local part proposes a
  link, at lower confidence than an address match.
- **AC-10** Proposals are deterministic and ordered, and never include an
  identity paired with itself.
- **AC-11** The Git provider emits an `agent` entity for a bot author and a
  `developer` for a person, and a bot never becomes a developer.
- **AC-12** Nothing in this Epic merges anything.

## 10. Test requirements

- normalization: casing, whitespace, plus-addressing, an empty address;
- both GitHub noreply forms, with and without the numeric prefix;
- each bot pattern, and a person whose name merely contains "bot";
- `.mailmap` in each documented form, with comments and malformed lines;
- mailmap applied, and not applied to an identity it does not name;
- candidate generation for each rule, and the absence of a name-only candidate;
- determinism: the same input twice, and no self-pairing;
- a Git provider test proving a bot commit yields an `agent`;
- a test asserting no merge is performed.

## 11. Security requirements

Names, addresses and `.mailmap` are repository content and therefore untrusted.
A `.mailmap` can claim any mapping, so it governs *identity within that
repository* and nothing else: it must never grant authority, and EPIC-083 will
not consult it. Addresses are personal data — they are recorded because Git
records them, they are redacted from logs by the existing rules, and a proposal
never reaches a log with an address in it.

Parsing is bounded: a `.mailmap` with a very large number of lines is truncated
rather than read whole, and no pattern used here can backtrack catastrophically.

## 12. Observability

Every classification and every proposal carries a machine-readable reason, so
"why is this contributor an agent" and "why were these two proposed as the same
person" are answerable from the record.

## 13. Performance constraints

One pass over `.mailmap`, parsed once per repository. Proposal generation is
grouped by normalized address rather than compared pairwise, so it is linear in
the number of identities rather than quadratic.

## 14. Definition of Done

Implementation, unit tests for every acceptance criterion, Git provider
emission, exports, documentation and validation evidence. No merging, no
cross-source resolution and no contribution ranking is claimed here.

## 15. Governance alignment

- **§5 Reuse Before Reinvent** — `.mailmap` is Git's answer; Ferret reads it
  rather than inventing a mapping format.
- **§6 Evidence Before Inference** — proposals carry confidence and a reason;
  nothing merges on a guess.
- **§9 Context Is First-Class** — who did something is context every later
  answer depends on.
- **§12 Security** — repository content is data, never authority.
- **§22 Change Management** — stays within the approved Developer Identity
  capability.
