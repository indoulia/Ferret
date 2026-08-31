# EPIC-013 — Provider Registry & Discovery: validation evidence

**Status: VALIDATED** · no database, no new runtime dependency; Node's own
dynamic `import()` is the whole loading mechanism.

## What discovery does

Takes an ordered list of module specifiers *from its caller*, imports each once,
and registers what they export through the existing `ProviderRegistry`. Every
module or provider it does not register comes back as a structured skip record
with a stable reason. It reads nothing to decide what to import.

## Acceptance criteria

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 default export loaded and registered | PASS | `discovers a default provider and preserves explicit order` |
| AC-2 named `provider` and `providers` | PASS | `accepts named and multiple provider exports` — one module returning two, one returning one |
| AC-3 deterministic caller and export order | PASS | same two tests: `loaded` matches caller order, and the three provider ids come back in export order |
| AC-4 validation stays in the registry | PASS (qualified) | every candidate that is a Provider object reaches `registry.register()`; see below |
| AC-5 unavailable module skipped, registry intact | PASS | `skips an unavailable module without losing existing providers` — the pre-registered provider survives |
| AC-6 malformed export does not partially register | PASS | `skips malformed modules and duplicate providers atomically`; `{}` is reported `invalid` and the registry still holds exactly one provider |
| AC-7 duplicate modules and ids reported, nothing replaced | PASS | same test: a repeated specifier and an already-registered id both yield `duplicate` skips |
| AC-8 blank specifier rejected without loading | PASS | `rejects blank specifiers without attempting a load` asserts the loader ran zero times |
| AC-9 repository content cannot cause execution | PASS | structural; see below |
| AC-10 machine-readable results | PASS | `ProviderDiscoveryResult` carries `modules`, `providers` and `skipped`; every skip has `module`, `reason` and `detail`, and every assertion above reads those fields rather than parsing text |

## AC-9, reviewed rather than asserted

§10 asks for an architecture and security review, not a test, and this is it.

`discovery.ts` imports exactly three things: `../errors/index.js`,
`./contract.js` and `./registry.js`. No filesystem, no config, no Git, no
repository input of any kind is reachable from it. Specifiers arrive as a
parameter; the default loader is `import(specifier)` and nothing else. There is
no path by which repository content reaches a module specifier.

The boundary test contributes a second guarantee from the other direction.
`providers/discovery.ts` joins its allowlist here, because §3 requires the
package to export the discovery contract and that pulls the file into the core
graph — the same reason `capabilities.ts` and `sdk/` were added for EPIC-011 and
EPIC-012. The rule the allowlist protects is unchanged and still enforced: what
the core may not reach is an *implementation*, and discovery imports no concrete
provider. Registering one remains something a caller does on purpose.

## AC-4, qualified

Discovery does apply one shape check of its own before registering — a
candidate that is not an object, or whose `id` is not a string, is reported
`invalid` and never reaches `registry.register()`. That is a guard to produce a
usable skip record rather than a second contract validation: everything that is
a Provider object goes to the registry, and the registry stays the only thing
that decides whether a provider is *valid*. Nothing invalid is registered by
either path.

## Defects found while recording this

**Seven lint errors had the branch red for nine hours**, failing both `verify`
jobs and the storage job before any test ran. `ProviderRegistry` was imported
as a value though only used as a type; `Array.isArray` widened a
`readonly Provider[]` union member to `any[]`, making the spread after it
unsafe; and five loader stubs in the tests were `async` with nothing to await.
All mechanical, all fixed. A type guard replaces the `Array.isArray` narrowing
so the spread keeps its element type.

**Two suite-wide assertions had not been updated for the new public surface**,
and only failed once the branch was brought up to date with `main`. The boundary
test rejected `providers/discovery.ts` in the core import graph, and the
distribution test enumerates the published subpaths exhaustively and did not
know about `./providers`. Both are the deliberate consequence of §3's public
export, and both now record why.

## Limitations

- **One import per unique specifier, and no retry.** A module that fails to
  load is skipped for the whole call; the caller re-runs discovery to try again.
- **Ordering is caller-supplied, not resolved.** Discovery does not sort by
  capability, priority or version — first registration wins, which is EPIC-011's
  semantics, and a caller listing modules in the wrong order gets the wrong
  precedence with no warning.
- **No lifecycle.** Discovery registers; it does not initialize, health-check or
  shut down a provider — EPIC-014.
- **No credentials** — EPIC-015 — and **no conformance suite** — EPIC-016, so a
  module can register a provider that satisfies the contract's shape and behaves
  incorrectly.
- **Trust is entirely the caller's.** A provider module is application code and
  runs with full privileges the moment it is imported. Discovery makes that
  explicit; it does not sandbox it.
