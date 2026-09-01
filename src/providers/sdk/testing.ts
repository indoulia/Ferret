import { parseConfig, withoutCredentialFields, type FerretConfig } from '../../config/index.js';
import type { LogFields, LogLevel, Logger } from '../../logging/index.js';
import type { CapabilityDeclaration } from '../capabilities.js';
import { Capability } from '../capabilities.js';
import { DEFAULT_PROVIDER_SETTINGS, type ProviderSettings } from '../configuration.js';
import type { Provider, ProviderContext } from '../contract.js';
import { PROVIDER_CONTRACT_VERSION, ProviderKind } from '../contract.js';

import type { ProviderOperationContext } from './operation.js';

/**
 * Test doubles, published rather than kept in `tests/`.
 *
 * A provider written outside this repository — which is the point of a provider
 * contract — has to be testable outside it too. Without these, an author's only
 * options are to point their tests at a live GitHub or to reconstruct a
 * `ProviderContext` from the type definition, and the second is a rite of
 * passage that teaches nothing.
 *
 * Exported through the `@indoulia/ferret/testing` subpath so nothing imports it
 * by accident from the package root.
 */

export interface CapturedLog {
  readonly level: Exclude<LogLevel, 'silent'>;
  readonly fields: LogFields;
  readonly message: string;
}

/**
 * A logger that keeps what it was given, unredacted.
 *
 * Unredacted deliberately: a test asserting "the password never reaches the
 * log" must inspect what was *passed in*, or it is checking the assertion
 * against an already-cleaned string and will pass whatever happens.
 */
export class CapturingLogger implements Logger {
  readonly level: LogLevel = 'trace';
  readonly records: CapturedLog[];
  readonly #bindings: LogFields;

  constructor(bindings: LogFields = {}, sink: CapturedLog[] = []) {
    this.#bindings = bindings;
    this.records = sink;
  }

  child(bindings: LogFields): Logger {
    return new CapturingLogger({ ...this.#bindings, ...bindings }, this.records);
  }

  trace(fields: LogFields, message: string): void {
    this.#write('trace', fields, message);
  }
  debug(fields: LogFields, message: string): void {
    this.#write('debug', fields, message);
  }
  info(fields: LogFields, message: string): void {
    this.#write('info', fields, message);
  }
  warn(fields: LogFields, message: string): void {
    this.#write('warn', fields, message);
  }
  error(fields: LogFields, message: string): void {
    this.#write('error', fields, message);
  }
  fatal(fields: LogFields, message: string): void {
    this.#write('fatal', fields, message);
  }

  /** Records at a level, for asserting what was said rather than that anything was. */
  at(level: CapturedLog['level']): readonly CapturedLog[] {
    return this.records.filter((record) => record.level === level);
  }

  /** Everything serialized, for "this string never appears anywhere" assertions. */
  dump(): string {
    return JSON.stringify(this.records);
  }

  #write(level: CapturedLog['level'], fields: LogFields, message: string): void {
    this.records.push({ level, fields: { ...this.#bindings, ...fields }, message });
  }
}

export interface TestProviderContext extends ProviderContext {
  readonly logger: CapturingLogger;
  /** Cancels the context, the way runtime shutdown would. */
  abort(reason?: unknown): void;
}

/**
 * A `ProviderContext` a test can construct in one line and cancel on demand.
 *
 * The configuration defaults to Ferret's own defaults rather than an empty
 * object, so a provider under test sees the same shape it will see in
 * production — including fields it did not know it depended on.
 */
export function createTestProviderContext(
  overrides: {
    readonly config?: FerretConfig;
    readonly logger?: CapturingLogger;
    readonly signal?: AbortSignal;
    readonly cwd?: string;
    readonly gitAvailable?: boolean;
    readonly settings?: ProviderSettings;
    /**
     * Credentials to grant, as the registry would for a provider that declared
     * them — EPIC-081. Absent grants none, which is what a provider that
     * declared none receives in production.
     */
    readonly credentials?: Readonly<Record<string, string>>;
  } = {},
): TestProviderContext {
  const controller = new AbortController();
  const logger = overrides.logger ?? new CapturingLogger();
  return {
    logger,
    // Projected, exactly as the registry projects it — EPIC-081 §8.1. A test
    // harness that handed over the password would let a provider pass here and
    // fail to compile in production, which is the wrong way round.
    config: withoutCredentialFields(overrides.config ?? parseConfig({})),
    credentials: overrides.credentials ?? {},
    environment: {
      ferretVersion: '0.0.0-test',
      node: { version: process.versions.node, major: 22, supportedRange: '>=22.0.0', supported: true },
      platform: process.platform,
      arch: process.arch,
      cwd: overrides.cwd ?? process.cwd(),
      interactive: false,
      git: overrides.gitAvailable === false ? { available: false } : { available: true, version: '2.55.0' },
    },
    signal: overrides.signal ?? controller.signal,
    settings: overrides.settings ?? DEFAULT_PROVIDER_SETTINGS,
    abort: (reason?: unknown): void => {
      controller.abort(reason);
    },
  };
}

/** A `ProviderOperationContext` for testing one operation in isolation. */
export function createTestOperationContext(
  overrides: { readonly logger?: Logger; readonly signal?: AbortSignal; readonly deadline?: number } = {},
): ProviderOperationContext & { abort: (reason?: unknown) => void } {
  const controller = new AbortController();
  return {
    logger: overrides.logger ?? new CapturingLogger(),
    signal: overrides.signal ?? controller.signal,
    ...(overrides.deadline === undefined ? {} : { deadline: overrides.deadline }),
    abort: (reason?: unknown): void => {
      controller.abort(reason);
    },
  };
}

export interface StubProviderOptions {
  readonly id?: string;
  readonly kind?: Provider['kind'];
  readonly contractVersion?: number;
  readonly capabilities?: readonly CapabilityDeclaration[];
  readonly description?: string;
  /** Thrown from `initialize`, to exercise a caller's failure handling. */
  readonly failInitializeWith?: Error;
  /** Thrown from `shutdown`. */
  readonly failShutdownWith?: Error;
  /** Awaited inside `initialize`, to hold it open while a race is arranged. */
  readonly initializeBarrier?: Promise<unknown>;
}

/**
 * A provider that does nothing, on request, in a controllable way.
 *
 * Records how often each lifecycle hook ran, which is how "exactly once under
 * concurrent calls" becomes an assertion rather than a hope.
 */
export class StubProvider implements Provider {
  readonly id: string;
  readonly kind: Provider['kind'];
  readonly contractVersion: number;
  readonly capabilities: readonly CapabilityDeclaration[];
  readonly description?: string;

  initializeCount = 0;
  shutdownCount = 0;
  context: ProviderContext | undefined;

  readonly #options: StubProviderOptions;

  constructor(options: StubProviderOptions = {}) {
    this.#options = options;
    this.id = options.id ?? 'test.stub';
    this.kind = options.kind ?? ProviderKind.SOURCE;
    this.contractVersion = options.contractVersion ?? PROVIDER_CONTRACT_VERSION;
    this.capabilities = options.capabilities ?? [
      { capability: Capability.SOURCE_REPOSITORY, version: 1 },
    ];
    if (options.description !== undefined) this.description = options.description;
  }

  async initialize(context: ProviderContext): Promise<void> {
    this.initializeCount += 1;
    this.context = context;
    if (this.#options.initializeBarrier !== undefined) await this.#options.initializeBarrier;
    if (this.#options.failInitializeWith !== undefined) throw this.#options.failInitializeWith;
  }

  async shutdown(): Promise<void> {
    this.shutdownCount += 1;
    if (this.#options.failShutdownWith !== undefined) throw this.#options.failShutdownWith;
    return Promise.resolve();
  }
}

/** A promise a test resolves when it chooses, for arranging a race. */
export function createBarrier(): { promise: Promise<void>; release: () => void; fail: (error: unknown) => void } {
  let release!: () => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { promise, release, fail };
}

/**
 * The conformance suite (EPIC-016).
 *
 * Re-exported here so `@indoulia/ferret/testing` is the single import a provider
 * author needs: the doubles to build a scenario, and the suite that checks the
 * contract. The cycle between the two modules is evaluation-safe — conformance
 * touches these doubles only inside functions.
 */
export {
  CONFORMANCE_CHECK_IDS,
  assertConformant,
  runConformance,
  type ConformanceCheck,
  type ConformanceOptions,
  type ConformanceReport,
  type ConformanceStatus,
} from './conformance.js';
