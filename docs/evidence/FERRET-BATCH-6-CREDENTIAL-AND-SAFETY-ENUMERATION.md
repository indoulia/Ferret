# Batch 6 — Credential and safety enumeration (F-94, F-71)

Branch `forensic/post-roadmap-audit`. Base `0407618`. No change to `main`, no PR, no merge,
no deploy, no Epic touched.

Scope as authorized: **F-94** and **F-71**, and nothing else. F-25, F-25b, F-27, F-11, F-44,
F-45 and F-101 are untouched.

## 1. One enumeration, failing towards exposure in two places

Both findings are the same defect wearing different clothes, and the triage said so before
either was opened: *F-30 + F-71 + F-94 is one enumeration.*

- `SAFETY_CONFIG` overrode eleven repository-controlled Git configuration keys, chosen for
  one property — "a key whose value names a program". A key that changes the **shape of
  Git's output** needs no program at all: it rewrites the stream Ferret's parser is reading,
  and the parser reports whatever it makes of the result as fact.
- `CREDENTIAL_ENV` named three environment variables. `FERRET_DATABASE_URL` carries the same
  database password and two other modules already treat it as a credential — it was simply
  not on the list.

The correction is not two longer lists. Each list is kept and extended where a vector was
actually measured, and each is now backed by a rule that does not depend on having named the
vector: Git's output is **verified to be the shape Ferret asked for**, and a variable is
judged a credential by **what it is** as well as by what it is called.

## 2. Failing evidence, before any implementation change

### F-94 — `tests/security/git-output-integrity.test.ts`

Real repository, real `git`, assertions on `readHistory`'s actual return value. Every hostile
case carries a **control** that proves the vector works when Ferret's overrides are not
applied, so a green result cannot come from a machine where the attack was never possible.

**11 of 17 assertions red.** The four encoding cases and both environment cases failed
identically:

```
i18n.logOutputEncoding: commit identity: expected [] to strictly equal [ …(3) ]
  - [ "bd5e295a82daba81eb3885ffa9a64b77f56221c3", "b8d8f380914a86a9fd2237ecaa02f755bb344a7f", … ]
  + []
```

Three commits in, **zero out**, no error, an empty page a caller cannot tell from a
repository with no history. This is F-94 as it stands *after* Batch 3: the record marker
Batch 3 introduced turned the fabrication the report measured (one invented commit under
`0407618e2001…`, this repository's own HEAD, taken from a filename) into silent total loss.
Both are the same defect — the repository decided what Ferret would report.

Red, with the reason each was red:

| Assertion | Why it was red |
| --- | --- |
| `i18n.logOutputEncoding=UTF-16` | 0 of 3 commits returned |
| `i18n.commitEncoding=UTF-16` | 0 of 3 — a second key with the same effect, not in the report |
| the same key via `include.path` | 0 of 3 — an alternate configuration path inside the repository |
| the same key via `config.worktree` | 0 of 3 — `extensions.worktreeConfig`; not in `.git/config` at all |
| `GIT_CONFIG_GLOBAL` in the inherited environment | 0 of 3 — not in `STRIPPED_ENV` |
| `GIT_CONFIG_SYSTEM` in the inherited environment | 0 of 3 — not in `STRIPPED_ENV` |
| `gpg.program` is not executed | **the program ran** |
| the five output-shape pins | none existed |
| the three parser-anomaly assertions | `parseHistoryOutput` did not exist |

Green before and after, deliberately — the controls that must not move: the baseline read,
`GIT_CONFIG_COUNT` (already stripped), the existing program-naming pins, `parseLog`'s
contract, and a healthy repository reporting nothing unreadable.

### F-71 — `tests/security/credential-surface.test.ts`

The surface measured against the unchanged code, so the evidence is behavioural rather than
"the API did not exist yet". **6 of 12** entries wrong, each reaching every `git` subprocess:

```
WRONG FERRET_DATABASE_URL     withoutCredentials keeps=true  scrubEnvironment keeps=true
WRONG PGSERVICEFILE           withoutCredentials keeps=true  scrubEnvironment keeps=true
WRONG PGSSLKEY                withoutCredentials keeps=true  scrubEnvironment keeps=true
WRONG DATABASE_URL            withoutCredentials keeps=true  scrubEnvironment keeps=true
WRONG SOME_VENDOR_API_TOKEN   withoutCredentials keeps=true  scrubEnvironment keeps=true
WRONG ANONYMOUS_HOLDER        withoutCredentials keeps=true  scrubEnvironment keeps=true
redactString(password) = "connect using ferret-f71-password-9f3a7c1e4b now"
GIT_CONFIG_GLOBAL stripped = false
GIT_CONFIG_SYSTEM stripped = false
```

The last three lines matter as much as the first six: Ferret's own resolved password had no
*shape* any pattern recognised, so it was redacted only where it happened to sit inside a URL
or after an `=`. Git's stderr, a `trace` log field and a `cause` chain are none of those.

29 of 31 assertions red. The two that passed are controls: URL redaction keeps the host, and
a benign diagnostic survives redaction.

## 3. The fix

### F-94, first half — pin what was measured

Five entries added to `SAFETY_CONFIG`, each with a measured vector rather than a guess:

| Pin | Measured effect without it |
| --- | --- |
| `i18n.logOutputEncoding=UTF-8` | re-encodes the whole `git log` stream, NUL separators included |
| `i18n.commitEncoding=UTF-8` | the same, by a different key |
| `log.showSignature=false` | with `gpg.program`, **executes a repository-named program** |
| `core.quotePath=false` | path shape; inert for today's `-z` readers, pinned for the next one |
| `diff.relative=false` | truncates `--name-status` paths when Git runs in a subdirectory |

`-c` was verified to beat all three repository-reachable configuration paths — `.git/config`,
`include.path`, and the `config.worktree` file `extensions.worktreeConfig` enables.

Two keys were investigated and are **not** pinned, because measurement said they are not
vectors: `log.mailmap` does not affect `%an`/`%ae` (only the capitalised `%aN`/`%aE`, which
Ferret does not use), and `format.pretty` does not override an explicit `--format`.

### F-94, second half — verify the shape, do not only pin the key

A pin is still an enumeration. `parseHistoryOutput` counts every token of Git's output that
falls outside a record, and `readHistory` reports the page as **incomplete** when the count
is non-zero — which stops the watermark advancing over a gap. That catches the key nobody has
found yet by its *effect*, without needing its name. `parseLog` keeps its old signature for
the callers that want only commits.

### F-71 — four rules, of which the list is one

`withoutCredentials` removes a variable when **any** of these holds:

1. **Named** — `CREDENTIAL_ENV`, now six entries: `FERRET_DATABASE_PASSWORD`,
   `FERRET_DATABASE_URL`, `PGPASSWORD`, `PGPASSFILE`, `PGSERVICEFILE`, `PGSSLKEY`.
2. **Registered** — a variable a `$secret` reference actually read from, and any value Ferret
   actually resolved. `{ "$secret": { "env": "MY_OWN_NAME" } }` is supported configuration,
   so the operator names those and no list here can.
3. **Named like a credential** — the same tokenised key rule errors and logs already redact
   by, now shared rather than copied.
4. **Shaped like a credential** — a URI carrying a password in its userinfo, or any provider
   format EPIC-082 detects, whatever the variable is called.

Registration happens where Ferret actually learns it holds a credential: at the secret-resolution
seam (every source, not each arm), and in `credentialsFor` for a password written literally in
`config.json`, which never passes through resolution at all.

`redactString` removes registered values, so a credential with no recognisable shape is
removed from every string that leaves the process. `gitVector` **refuses** an argument or
working directory carrying one, because `argv` is readable by other processes and a redacted
argument would be a different argument.

**The module's old argument is reversed on the record, not silently.** It said an explicit
list was right because pattern-matching would remove variables belonging to the user. That is
no longer true: every child Ferret starts is `git`, read-only, with `credential.helper=`,
`core.sshCommand=` and `GIT_TERMINAL_PROMPT=0`. Nothing in that tree has a legitimate use for
any credential, the operator's included.

## 4. Second-order defects found by re-auditing, and corrected

Six, none of them in the original findings.

1. **`gpg.program` is an execution vector `SAFETY_CONFIG` missed.** F-94 is an *output*
   finding; re-auditing it against "what else does `git log` consult" found that
   `log.showSignature=true` plus a repository-named `gpg.program` runs that program on every
   `git log`, on Windows too. Verified by fixture: the program executed, and does not now.
2. **`GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` were not stripped.** `STRIPPED_ENV` was
   written before those names existed. Fixed by the *rule* rather than by two more names:
   `scrubEnvironment` strips every `GIT_CONFIG*` variable by prefix, so it cannot fall a Git
   release behind again.
3. **`incomplete.reason` repeated Git's stderr unredacted** into a page, a log line and a
   skipped-path report. Now through the same `redactString` as everything else, and asserted
   *not* to empty the diagnostic.
4. **`redactVector` knew one credential shape.** It carried a single `//user:pass@`
   expression, so a token in any other position — and any credential Ferret itself resolved —
   was written verbatim to a `trace` field. Now `redactString`.
5. **`PWD` was being stripped from every child.** Found by measuring
   `withoutCredentials(process.env)` on a real machine rather than by reasoning: `isSecretKey`
   is written for configuration keys, where `pwd` means password, and as an environment
   variable it is the working directory. Solving disclosure by destroying the environment is
   this file's other failure mode. An exemption suspends the *name* rule only — a `PWD` whose
   value is a connection URL is still removed.
6. **Two spawners, two environment policies.** `detectGit` scrubbed credentials but not the
   Git-redirect variables. Unified — and the first attempt at unifying was itself wrong: it
   imported `git/runner.ts` from `environment/`, which `boundaries.test.ts` refused, correctly,
   because replacing the Git provider must not require a core change. The policy now lives in
   `src/security/subprocess.ts`, which is its right home: what a child may inherit is a
   property of Ferret's process boundary, not of Git.

Two further corrections came from Ferret's own controls rather than from reading:

- **`control-reachability.test.ts`** reported `CREDENTIAL_ENV` and `withoutCredentials` dead
  after the unification, and was right — their only caller had become a sibling inside
  `security/`. The barrel now declares `scrubEnvironment`, which production actually calls,
  and the two become internals, exactly as `containsSecret` and `delimitersBalanced` already
  are. The two tests that assert on them import from `./credentials.js` directly.
- **The packaging secret scan** flagged `dist/security/credentials.js`, because a comment
  contained a realistic credentialled URI as a worked example. Correctly — `secrets.ts`
  already carries a note about this exact trap. The example is gone.

## 5. A performance claim, corrected by its own measurement

The four rules run thirteen regular expressions per variable, and `scrubEnvironment` is
called once per `git` — once per blob during an index. First measurement: 0.73 ms on a
128-variable environment, which reads as seven seconds on a ten-thousand-file repository. A
decision cache was added, keyed by name with the value compared rather than concatenated into
the key (`PATH` is four kilobytes; building a key out of it cost more than the rules did).

Then the cost was **split**, and the first reading turns out to have been wrong:

```
old_shape_copy_and_delete=0.4197ms | entries_rebuild_only=0.3772ms
withoutCredentials=0.3834ms        | scrubEnvironment=0.4670ms
```

Copying `process.env` at all already cost 0.42 ms before any of this existed. The four rules
are ~0.05 ms of the total; the cache saves the ~0.26 ms of regular expressions. The cache
earns its place, and the alarming figure was Node's environment object rather than this
change. Recorded because a security fix defended by a wrong performance number is a fix
nobody can check.

## 6. Paths audited and found sound

- **Every spawner.** `execFile` and `spawn` in `git/runner.ts`, and the promisified
  `execFile` in `environment/detect.ts`. There are no others in `src/`;
  `credential-containment.test.ts` enumerates them from source and both are covered by the
  captured-environment assertions here.
- **Serialization.** `redact()` walks arrays and plain objects and calls `redactString` on
  every leaf, so a registered credential nested inside an error's `details` is removed.
- **Generated command strings.** `backupCommandFor` was fixed in Batch 2 (F-30) and still
  redacts; the `FERRET_DATABASE_URL` it reads is now also a named credential.
- **`textconv` and named diff drivers.** A repository can define `diff.<name>.textconv`, which
  names a program, and `.gitattributes` can select it. Not reachable: Ferret runs
  `--name-status` and never a content diff. Recorded rather than pinned, because pinning a key
  no command consults would be an enumeration entry that proves nothing.
- **Global and system Git configuration.** Not disabled. `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`
  are stripped so a *client-supplied* environment cannot redirect Git at a hostile file, which
  leaves the operator's own `~/.gitconfig` — theirs, not a repository's — and every key that
  matters is pinned above it anyway.

## 7. Non-secret metadata is preserved

Asserted from the same table as the stripping, so neither half can be improved at the other's
expense: `PATH`, `HOME`, `LANG`, `PWD`, and `FERRET_DATABASE_HOST`, `_USER`, `_PORT`, `_NAME`,
`FERRET_LOG_LEVEL` all survive into the child. A redacted URL keeps its scheme, user, host and
database. An incomplete page keeps the reason it was incomplete. A refused argument names no
value but does name the operation.

Two floors are stated rather than hidden: values under **8** characters are not tracked by
content, because substring removal on a short value destroys diagnostics; and only values of
**12** characters or more can cause an argument to be *refused*, because that consequence is a
stopped index and a coincidence is what would stop it.

## 8. A test replaced rather than repaired

The first version of the `incomplete.reason` assertion called `redactString` directly — the
wrong layer, and it proved nothing about the line it was written for. It now drives real Git:
an object deleted from the middle of a history, so Git streams the newer commits and *then*
exits non-zero. The second version of it was also wrong — a commit with a missing parent makes
Git fail *before* flushing anything, which is the "no history here" branch — and that is
recorded in the test, because the version that asserted the wrong branch passed nothing while
looking correct.

## 9. Verification

`lint && typecheck && build && vitest run`: **3491 passed, 7 skipped, 0 failed** (172 files,
357 s).

The run before it failed five, and all five were real:

| Failure | Cause | Resolution |
| --- | --- | --- |
| `boundaries` × 2 | `environment/detect.ts` importing `git/runner.ts` | policy moved to `security/subprocess.ts` |
| `packaging` — credentialled URI | a worked example in a new comment | example removed |
| `packaging` — size | +29 207 bytes, 0.50% over the bound | measured on both sides, bound moved with the record |
| `credential-isolation` | `CREDENTIAL_ENV` grew | the assertion did its job; updated with the reason |

**F-92, F-73 and F-101 are kept separate and none fired.** `discovery.test.ts`'s wide-tree walk
passed; packaging completed all 34 tests rather than skipping them; and
`scale.test.ts > scans rather than indexes when the whole table is wanted` passed. F-101 *did*
fire in the run that preceded the fixes to the five above and passed in the final run with the
same code for that test — which is the intermittent, planner-dependent behaviour F-101
already records, and is why it stays a separate infrastructure finding rather than becoming
this batch's problem.

The package bound was raised from 2 840 000 to 2 950 000, measured first on both sides —
2 788 627 in `dist/` with the batch stashed, 2 817 834 with it applied — with the per-directory
breakdown written into the test beside the three earlier raises.

## 10. Files changed

Source: `src/security/credentials.ts` · `src/security/subprocess.ts` (new) ·
`src/security/secrets.ts` · `src/security/index.ts` · `src/errors/redact.ts` ·
`src/git/runner.ts` · `src/git/history.ts` · `src/git/index.ts` · `src/config/secret-ref.ts` ·
`src/config/credentials.ts` · `src/environment/detect.ts`.

Tests: `tests/security/git-output-integrity.test.ts` (new),
`tests/security/credential-surface.test.ts` (new); `tests/unit/credential-isolation.test.ts`,
`tests/security/credential-containment.test.ts` and `tests/integration/packaging.test.ts`
updated for what changed beneath them.

## 11. What this does not claim

- It does not claim the configuration pins are complete. They are an enumeration, and this
  audit has watched enumerations fail. The claim is that an unenumerated key now produces a
  page that **says it is incomplete** instead of a page that is silently wrong.
- It does not claim a credential can never leave. A value under eight characters is not
  tracked by content, and a credential Ferret never resolves — one the operator holds under a
  name that reads as ordinary and whose value has no credential shape — is not covered by any
  of the four rules.
- It does not claim `git` needs nothing that is now removed. It claims the opposite is
  measured on one machine, and the preserved half of the table is what a second machine would
  fail on.
- F-92, F-73 and F-101 remain open and unowned by this batch.
