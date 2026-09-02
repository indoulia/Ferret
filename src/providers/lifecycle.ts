import { ErrorCode, FerretError } from '../errors/index.js';

/**
 * Provider lifecycle — EPIC-014.
 *
 * EPIC-093 §16 asked the question this module answers: *"if a failed optional
 * provider should ever recover without a restart of Ferret, that is EPIC-014's
 * to design."* Today it cannot — `initializeAll` records the failure and
 * continues, correctly, and there is no path back. On a long-running MCP server
 * a database that was down for ten seconds at start-up costs the whole session.
 */

/**
 * Where a provider is, **as the registry sees it**. Exactly one of these.
 *
 * Not the same thing as `BaseProvider`'s `ProviderState`, and the distinction
 * is load-bearing rather than a naming accident:
 *
 * - `ProviderState` (created → initializing → ready → stopped) is a provider's
 *   view of *itself*, and only a provider that extends `BaseProvider` has one.
 * - This is the registry's view of a provider, and it holds facts a provider
 *   cannot know about itself — that configuration switched it off, that it was
 *   registered optional, that it has failed four times.
 *
 * Derived from the registry's existing sets rather than stored beside them: two
 * places recording the same fact is how they come to disagree. The sets are
 * already the truth; this gives them one name.
 */
export const ProviderLifecycleState = {
  /** Registered, and `initializeAll` has not run yet. */
  REGISTERED: 'registered',
  /** `initialize` succeeded — or a recovery did. */
  INITIALIZED: 'initialized',
  /** Switched off in configuration. A choice, not a fault. */
  DISABLED: 'disabled',
  /** An optional provider whose `initialize` threw, and may be recovered. */
  FAILED: 'failed',
  /** Failed {@link MAX_RECOVERY_ATTEMPTS} times. Recovery refuses. */
  UNRECOVERABLE: 'unrecoverable',
  /** `shutdownAll` has run. */
  RELEASED: 'released',
} as const;

export type ProviderLifecycleState = (typeof ProviderLifecycleState)[keyof typeof ProviderLifecycleState];

/**
 * How many times a recovery is attempted before the circuit opens.
 *
 * Bounded for honesty rather than efficiency: a provider that has failed to
 * initialize four times is not going to succeed on the fifth for any reason a
 * caller can act on, and an unbounded retry turns a permanent misconfiguration
 * into a permanent stream of warnings.
 */
export const MAX_RECOVERY_ATTEMPTS = 4;

/** Why a recovery was refused. Each has a different remediation. */
export const RecoveryRefusal = {
  /** Not registered. */
  UNKNOWN: 'unknown-provider',
  /** Working. Restarting it would be a fault Ferret invented. */
  ALREADY_RUNNING: 'already-running',
  /** `enabled: false`. Off is a choice. */
  DISABLED: 'disabled',
  /** Registered required — its failure already ended the process. */
  REQUIRED: 'required',
  /** The circuit is open. */
  EXHAUSTED: 'attempts-exhausted',
} as const;

export type RecoveryRefusal = (typeof RecoveryRefusal)[keyof typeof RecoveryRefusal];

export interface ProviderLifecycle {
  readonly providerId: string;
  readonly state: ProviderLifecycleState;
  /** The code the last failure carried. Never its message — EPIC-093's rule. */
  readonly failureCode?: string | undefined;
  /** Failed initialize attempts, including the one at start-up. */
  readonly attempts: number;
}

/** Attempted, and what happened. */
export interface RecoveryResult {
  readonly providerId: string;
  readonly state: ProviderLifecycleState;
  readonly recovered: boolean;
  /** Present when the attempt was refused before `initialize` was called. */
  readonly refused?: RecoveryRefusal | undefined;
  readonly failureCode?: string | undefined;
  readonly attempts: number;
}

/**
 * Tracks failed attempts per provider.
 *
 * Separate from the registry's `#failed` map, which records *that* a provider
 * failed and with which code. This records *how many times*, which is what the
 * circuit needs and what a single code cannot carry.
 */
export class RecoveryBudget {
  readonly #attempts = new Map<string, number>();

  /** Records a failure and returns the new count. */
  record(providerId: string): number {
    const next = (this.#attempts.get(providerId) ?? 0) + 1;
    this.#attempts.set(providerId, next);
    return next;
  }

  attemptsFor(providerId: string): number {
    return this.#attempts.get(providerId) ?? 0;
  }

  /**
   * Clears the count. Called on success only — §8.3.
   *
   * Nothing else resets it: a caller who believes the underlying cause is fixed
   * restarts Ferret, which is the honest signal that something outside Ferret
   * changed.
   */
  clear(providerId: string): void {
    this.#attempts.delete(providerId);
  }

  exhausted(providerId: string): boolean {
    return this.attemptsFor(providerId) >= MAX_RECOVERY_ATTEMPTS;
  }
}

/** The message and remediation for each refusal, so a caller can act. */
export function describeRefusal(providerId: string, refusal: RecoveryRefusal): FerretError {
  const cases: Readonly<Record<RecoveryRefusal, { message: string; remediation: string }>> = {
    [RecoveryRefusal.UNKNOWN]: {
      message: `No provider "${providerId}" is registered.`,
      remediation: 'Check the id against `ferret status`, which lists every registered provider.',
    },
    [RecoveryRefusal.ALREADY_RUNNING]: {
      message: `Provider "${providerId}" is running; there is nothing to recover.`,
      remediation: 'Recovery re-initializes a provider that failed. A working provider is left alone.',
    },
    [RecoveryRefusal.DISABLED]: {
      message: `Provider "${providerId}" is switched off in configuration.`,
      remediation: `Set \`providers.${providerId}.enabled\` to true and restart, rather than recovering it.`,
    },
    [RecoveryRefusal.REQUIRED]: {
      message: `Provider "${providerId}" is required, so there is nothing in this process to recover.`,
      // §8.4 — a required provider's failure already tore the process down, so
      // a recovery here would imply Ferret was running usefully without it.
      remediation: 'A required provider that fails ends the run. Fix the underlying cause and start Ferret again.',
    },
    [RecoveryRefusal.EXHAUSTED]: {
      message: `Provider "${providerId}" has failed to initialize ${String(MAX_RECOVERY_ATTEMPTS)} times and will not be retried.`,
      remediation:
        'Fix the underlying cause and restart Ferret. The circuit does not close on its own, because nothing here can observe that the cause was fixed.',
    },
  };

  const { message, remediation } = cases[refusal];
  return new FerretError(ErrorCode.PROVIDER_INIT_FAILED, message, {
    details: { providerId, refusal },
    remediation,
    retryable: false,
  });
}
