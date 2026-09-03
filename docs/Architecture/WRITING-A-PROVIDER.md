# Writing a Ferret provider

> EPIC-074. Everything here is public API: `@indoulia/ferret/providers` for the
> contract, `@indoulia/ferret/testing` for the conformance suite. Nothing in
> this guide needs a change to Ferret.

## What a provider is

A provider is an object that declares an id, a kind, a contract version and a
set of **capabilities**. Ferret selects providers by capability and never by
name, so a provider becomes reachable by declaring one — not by being imported
somewhere.

```ts
import {
  BaseProvider,
  Capability,
  CAPABILITY_VERSIONS,
  ProviderKind,
  type Provider,
} from '@indoulia/ferret/providers';

export class TrackerProvider extends BaseProvider implements Provider {
  readonly id = 'acme.source.tracker';
  readonly kind = ProviderKind.SOURCE;
  readonly description = 'Acme tracker issues';
  readonly capabilities = [
    {
      capability: Capability.SOURCE_PROJECT,
      version: CAPABILITY_VERSIONS[Capability.SOURCE_PROJECT],
      operations: ['list-issues'],
      systems: ['acme'],
    },
  ];
}
```

Declare **operations you implement**, one by one. A declaration that said
"everything" would silently start claiming the next operation added to the
capability before it existed — which is why every Ferret provider names them.

## The manifest

Add a `ferret.provider` field to your `package.json`:

```json
{
  "name": "@acme/ferret-tracker",
  "ferret": {
    "provider": {
      "id": "acme.source.tracker",
      "contractVersion": 1,
      "capabilities": ["source.project"],
      "description": "Acme tracker issues"
    }
  }
}
```

Ferret reads this **before importing your package**, so a package built against
a contract version this Ferret does not support is declined with a sentence
rather than a stack trace. Importing is executing, and a refusal after the
import is a refusal after the fact.

The manifest is a compatibility courtesy and **not a security boundary**: you
write it yourself, so a hostile package simply lies. What authorises loading a
module is a human naming it in configuration.

## Getting loaded

```json
{ "providerModules": ["@acme/ferret-tracker"] }
```

Ferret never scans a repository, a package tree or a policy file for code to
run. This list is the only way in, and writing it is authorising arbitrary code
execution — which is the honest description of installing any plugin.

Export your provider as `default`, `provider`, or `providers`:

```ts
export const provider = new TrackerProvider();
```

## Configuration and secrets

Declare a schema and Ferret validates your options before `initialize`:

```ts
readonly configSchema = z.object({ baseUrl: z.string().url() }).strict();
readonly secretOptions = ['token'];
```

`secretOptions` is how a value becomes redactable — redaction by key name cannot
know that `token` is a credential. A declared option may be written as a secret
reference, and Ferret resolves it before your provider is constructed:

```json
{ "providers": { "acme.source.tracker": { "options": {
  "token": { "$secret": { "env": "ACME_TOKEN" } }
} } } }
```

## Extending the model

A provider may register an entity kind and a relationship type, and neither
needs a change to Ferret:

```ts
import { registerEntityKind, registerRelationshipType } from '@indoulia/ferret';

registerEntityKind('acme_ticket', z.object({ severity: z.string().optional() }).strict());
registerRelationshipType('acme_ticket_blocks_issue', {
  fromKinds: ['acme_ticket'],
  toKinds: ['issue'],
  exclusiveFrom: false,
});
```

Registered kinds are **validated**, not waved through: your schema is enforced
on every entity of that kind, and an unregistered relationship type is refused.

## Emitting knowledge

Use the `Emitter`, which attaches attribution by construction:

```ts
const emitter = new Emitter({
  sourceSystem: 'acme',
  producer: this.id,
  producerVersion: VERSION,
  systemOfRecord: true,
});
```

`producerVersion` is mandatory because Governance §21's question — *"re-extract
everything the old parser touched"* — is otherwise unanswerable. `systemOfRecord`
is for a provider reading the system that **owns** the fact; nothing is the
system of record for everything.

Two rules worth stating:

- **Evidence for a claim, not for a field.** Emit evidence for what somebody
  will ask you to justify. Evidence for every field is evidence nobody reads.
- **An inference says so.** `emitter.inferred` requires `derivedFrom`, and
  `derivedFrom` names *evidence records*, not entities.

## Proving it works

```ts
import { runConformance } from '@indoulia/ferret/testing';

const report = await runConformance({ create: () => new TrackerProvider() });
expect(report.conformant).toBe(true);
```

The conformance suite checks registration, capability declaration, lifecycle,
cancellation, error classification and secret handling. Ferret runs it against
its own providers in CI and a provider that nothing runs it against is a failing
build there — so it is worth running against yours.

## What Ferret will not do for you

- **It will not sandbox you.** A provider runs in-process with full privileges.
  The framework bounds parsers by size and time; it does not contain them.
- **It will not retry your network calls.** EPIC-079 owns backoff for Ferret's
  own operations; a provider owns its transport, including its rate limit.
- **It will not merge your entities with anybody else's.** Cross-source
  resolution proposes; `IdentityStore.merge` requires evidence and a decision.
