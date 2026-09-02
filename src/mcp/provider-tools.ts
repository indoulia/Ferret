import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  EffectChange,
  Permission,
  type ConfirmationGate,
  type OperationPlan,
  type Principal,
} from '../authorization/index.js';
import type { AuditWriter } from '../audit/index.js';
import type { Logger } from '../logging/index.js';
import {
  CapabilitySupport,
  ProviderLifecycleState,
  describeRefusal,
  type Capability,
  type CapabilityVerdict,
  type ProviderDescriptor,
  type ProviderLifecycle,
  type RecoveryResult,
} from '../providers/index.js';

import {
  CONFIRM_PARAMETER_DESCRIPTION,
  createDestructiveToolGuard,
  createToolGuard,
  type ToolGuard,
} from './guards.js';

/**
 * Provider administration, over MCP — EPIC-067.
 *
 * EPIC-059/065's validation recorded the gap in one sentence: *"An AI client
 * cannot index, configure or manage providers — only read."* EPIC-066 took
 * *configure*. This takes **providers**.
 *
 * The concrete cost was a question a client could not answer. When semantic
 * retrieval is unavailable, a client saw results without embeddings and had no
 * way to learn *why* — whether no provider offers it, one offers it and is
 * switched off, or one offers it and failed to start. Those need three different
 * things done about them, and Ferret already knew which it was.
 *
 * **Nothing here enables or disables a provider.** That is a configuration
 * change and EPIC-066 already has it — `ferret_config_set
 * providers.<id>.enabled` — and a second path to the same setting would be a
 * second set of durability bugs.
 */

/**
 * What this surface needs from a registry.
 *
 * Four questions rather than the class, so the MCP layer depends on the
 * questions it asks. Every one of them already exists on `ProviderRegistry`;
 * this Epic adds no registry behaviour.
 */
export interface ProviderAdministration {
  readonly describe: () => readonly ProviderDescriptor[];
  readonly states: () => readonly ProviderLifecycle[];
  /** Capabilities at least one enabled, started provider offers. */
  readonly capabilities: () => readonly Capability[];
  /** Every capability Ferret knows about, for the unavailable ones. */
  readonly known: () => readonly Capability[];
  readonly supports: (capability: Capability) => CapabilityVerdict;
  readonly recover: (providerId: string) => Promise<RecoveryResult>;
}

export interface ProviderToolDependencies {
  readonly providers: ProviderAdministration;
  readonly logger: Logger;
  readonly principal: Principal;
  readonly confirmations: ConfirmationGate;
  readonly audit?: AuditWriter | undefined;
}

/** One provider, as a client sees it. */
interface ReportedProvider {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly enabled: boolean;
  /** The code it failed with. Never a message — EPIC-093's rule, §8.4. */
  readonly failureCode?: string | undefined;
  readonly failedAttempts?: number | undefined;
  readonly recoverable?: boolean | undefined;
  readonly description?: string | undefined;
}

/** Why a capability cannot be served — §8.3, and there are three answers. */
interface MissingCapability {
  readonly capability: string;
  readonly support: string;
  readonly reason: string;
  /** The provider that offers it, when one does but cannot serve it. */
  readonly providerId?: string | undefined;
  readonly failureCode?: string | undefined;
  readonly remediation?: string | undefined;
}

/**
 * Explains one unavailable capability — §8.3.
 *
 * Driven by which providers *declare* the capability, **not** by
 * `supports()`. That was a finding: `ProviderRegistry.supports` reports
 * `unavailable` with no `providerId` for a capability whose only provider
 * failed or was switched off, because `#offered` filters those out — and for a
 * caller *selecting* a provider that is exactly right, since a failed provider
 * is not a usable one. EPIC-093 §8.3 chose it deliberately: "handing a caller
 * an object whose `initialize` threw is worse than handing it nothing."
 *
 * But an operator asking *why* needs the three cases apart, and the declaration
 * survives the filter — `describe()` reports every provider's declared
 * capabilities whatever state it is in. So the first three answers come from
 * there, and the verdict is consulted only for the cases it is the authority on:
 * a version this runtime cannot honour, or an operation a provider did not
 * implement.
 */
function explain(
  capability: Capability,
  verdict: CapabilityVerdict,
  declaredBy: readonly ReportedProvider[],
): MissingCapability {
  if (declaredBy.length === 0) {
    return {
      capability,
      support: CapabilitySupport.UNAVAILABLE,
      reason: 'No registered provider offers this capability.',
      remediation: `Install and configure a provider that implements ${capability}.`,
    };
  }

  // The first declarer, which is the one selection would have chosen.
  const provider = declaredBy[0] as ReportedProvider;

  if (!provider.enabled) {
    return {
      capability,
      support: CapabilitySupport.UNAVAILABLE,
      providerId: provider.id,
      reason: `The provider that offers it ("${provider.id}") is switched off in configuration.`,
      remediation: `Set \`providers.${provider.id}.enabled\` to true with \`ferret_config_set\`, then restart Ferret.`,
    };
  }

  if (provider.failureCode !== undefined) {
    return {
      capability,
      support: CapabilitySupport.UNAVAILABLE,
      providerId: provider.id,
      failureCode: provider.failureCode,
      reason: `The provider that offers it ("${provider.id}") did not start.`,
      remediation:
        provider.recoverable === true
          ? `Fix the underlying cause, then call \`ferret_provider_recover\` with providerId "${provider.id}".`
          : 'Fix the underlying cause and restart Ferret; the recovery budget for this provider is spent.',
    };
  }

  // Declared, enabled, started — so the verdict is the authority: a version
  // this runtime cannot honour, or an operation the provider did not implement.
  return {
    capability,
    support: verdict.support,
    providerId: provider.id,
    reason: verdict.detail,
    remediation: verdict.remediation,
  };
}

function report(
  descriptors: readonly ProviderDescriptor[],
  states: readonly ProviderLifecycle[],
): readonly ReportedProvider[] {
  const stateById = new Map(states.map((one) => [one.providerId, one]));
  return descriptors.map((descriptor) => {
    const state = stateById.get(descriptor.id);
    return {
      id: descriptor.id,
      kind: descriptor.kind,
      state: state?.state ?? ProviderLifecycleState.REGISTERED,
      enabled: descriptor.enabled,
      // §8.4 and AC-5: the code, and never a message or an option value.
      // EPIC-081 put credentials in provider options, so a tool that returned
      // them would undo that Epic.
      ...(descriptor.failure === undefined ? {} : { failureCode: descriptor.failure }),
      ...(state === undefined ? {} : { failedAttempts: state.attempts }),
      ...(state === undefined
        ? {}
        : { recoverable: state.state === ProviderLifecycleState.FAILED }),
      ...(descriptor.description === undefined ? {} : { description: descriptor.description }),
    };
  });
}

/**
 * Registers the provider-administration tools.
 *
 * Its own module rather than more of `server.ts`, following EPIC-066's reason:
 * that file is already the longest in the project, and
 * `tests/unit/mcp-destructive-tools.test.ts` scans every module in `src/mcp/`
 * so a control naming one file would stop covering the surface.
 */
export function registerProviderTools(server: McpServer, dependencies: ProviderToolDependencies): void {
  const { providers, logger, principal, confirmations, audit } = dependencies;
  const guard: ToolGuard = createToolGuard({
    principal,
    logger,
    ...(audit === undefined ? {} : { audit }),
  });
  const guardDestructive = createDestructiveToolGuard({ principal, logger, confirmations }, guard);

  server.registerTool(
    'ferret_providers',
    {
      title: 'List Ferret providers and what they offer',
      description:
        'Report every provider Ferret has registered, the state it is in, and ' +
        'which capabilities are available. For a capability that is *not* ' +
        'available, the answer says which of three things happened: no provider ' +
        'offers it, the provider that offers it is switched off, or the provider ' +
        'that offers it failed to start. Use this when a search returned less ' +
        'than expected — it distinguishes a missing dependency from a decision ' +
        'and from a failure. No provider option values are returned.',
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      // A read, so `READ`. And no audit event: EPIC-085 §4 decided reads are
      // not audited — "every search would be an event, which is a log rather
      // than an audit trail" — and §16 records that this leaves "who looked at
      // our provider configuration" unanswerable from the trail.
      guard('providers', Permission.READ, () => {
        const descriptors = providers.describe();
        const described = report(descriptors, providers.states());
        const byId = new Map(described.map((one) => [one.id, one]));
        const available = providers.capabilities();
        const availableSet = new Set<string>(available);

        // Which providers *declare* each capability, whatever state they are
        // in — see `explain` for why the verdict cannot answer that.
        const declarers = new Map<string, ReportedProvider[]>();
        for (const descriptor of descriptors) {
          for (const capability of descriptor.capabilities) {
            const reported = byId.get(descriptor.id);
            if (reported === undefined) continue;
            declarers.set(capability, [...(declarers.get(capability) ?? []), reported]);
          }
        }

        const missing = providers
          .known()
          .filter((capability) => !availableSet.has(capability))
          .map((capability) =>
            explain(capability, providers.supports(capability), declarers.get(capability) ?? []),
          );

        return Promise.resolve({
          providers: described,
          availableCapabilities: [...available].sort(),
          missingCapabilities: missing,
          notice:
            missing.length === 0
              ? 'Every capability Ferret knows about is available.'
              : 'A capability is unavailable for one of three reasons, and each needs something different done about it.',
        });
      }),
  );

  server.registerTool(
    'ferret_provider_recover',
    {
      title: 'Retry a provider that failed to start',
      description:
        'Make one attempt to initialize a provider whose start-up failed, so the ' +
        'capabilities it offers become available without restarting Ferret. Only ' +
        'a provider registered as optional and currently `failed` can be ' +
        'recovered: a required one already ended the run, a disabled one is a ' +
        'configuration decision, a running one needs nothing, and one that has ' +
        'failed four times will not be retried. Call `ferret_providers` first to ' +
        'see which state a provider is in. Omit `confirm` to see the plan.',
      inputSchema: z.strictObject({
        providerId: z
          .string()
          .min(1)
          .max(128)
          .describe('The provider id, as `ferret_providers` reports it.'),
        confirm: z.string().min(1).max(256).optional().describe(CONFIRM_PARAMETER_DESCRIPTION),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ providerId, confirm }) =>
      // Through the **destructive** guard, and §8.2 was rewritten to say so.
      //
      // The first draft argued a recovery is not destructive — it re-runs an
      // `initialize` the composition root already registered — and gave it the
      // plain guard. `mcp-destructive-tools.test.ts` refused it, and it was
      // right to: the control's contract is *not read-only*, not "deletes
      // something", and its whole value is having no exceptions. A tool that
      // simply never calls the gate is the failure mode that test exists to
      // catch, and this would have been the first one. A recovery does mutate
      // what Ferret can do.
      //
      // `INDEX` rather than `CONFIG_WRITE`: nothing is written to
      // configuration. What changes is which capabilities are selectable.
      guardDestructive(
        'provider.recover',
        Permission.INDEX,
        // The plan runs inside the thunk, after the permission check — the
        // ordering EPIC-066 found by test: a throw above the guard reaches the
        // client as an unredacted protocol error with no code to branch on.
        () => planForRecover(providers, providerId),
        confirm,
        async () => {
          const result = await providers.recover(providerId);

          if (result.refused !== undefined) {
            // §8.5 — EPIC-014 has five refusals with five remediations, and a
            // client told "disabled" changes configuration while one told
            // "required" restarts Ferret. Collapsing them into "could not
            // recover" would make four of the five useless.
            const refusal = describeRefusal(providerId, result.refused);
            return {
              providerId,
              recovered: false,
              state: result.state,
              refused: result.refused,
              reason: refusal.message,
              remediation: refusal.remediation,
            };
          }

          return {
            providerId,
            recovered: result.recovered,
            state: result.state,
            failedAttempts: result.attempts,
            ...(result.failureCode === undefined ? {} : { failureCode: result.failureCode }),
            notice: result.recovered
              ? 'The capabilities this provider offers are available again. Call ferret_providers to confirm.'
              : 'The attempt failed. Fix the underlying cause before retrying; the budget is bounded.',
          };
        },
      ),
  );
}

/**
 * What a recovery would do, for the confirmation.
 *
 * Names the state the provider is in now, so a client seeing the plan can tell
 * a recovery that will be refused from one that will be attempted — rather than
 * spending a confirmation round trip to find out.
 */
function planForRecover(providers: ProviderAdministration, providerId: string): OperationPlan {
  const current = providers.states().find((one) => one.providerId === providerId);
  return {
    operation: 'provider.recover',
    summary:
      current === undefined
        ? `No provider "${providerId}" is registered; the attempt will be refused.`
        : `Re-run initialize for "${providerId}", which is currently ${current.state}.`,
    effects: [
      {
        target: providerId,
        change: EffectChange.SET,
        ...(current === undefined ? {} : { from: current.state }),
        to: ProviderLifecycleState.INITIALIZED,
      },
    ],
  };
}
