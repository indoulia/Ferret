import { randomUUID } from 'node:crypto';

import { credentialsFor, parseConfig, type FerretConfig } from '../../config/index.js';
import { DependencyStatus, type DependencyCheckResult } from '../../diagnostics/index.js';
import { ErrorCode, FerretError } from '../../errors/index.js';
import { validateCapabilityDeclaration, type Capability } from '../capabilities.js';
import { providerSettings, type ProviderSettings } from '../configuration.js';
import {
  PROVIDER_ID_PATTERN,
  isProviderKind,
  isSupportedContractVersion,
  MINIMUM_PROVIDER_CONTRACT_VERSION,
  PROVIDER_CONTRACT_VERSION,
  type Provider,
  type ProviderContext,
} from '../contract.js';
import { ProviderRegistry } from '../registry.js';

import { CapturingLogger, createTestProviderContext } from './testing.js';

/**
 * The provider contract, made executable.
 *
 * EPIC-011 states it in prose and types, EPIC-012 implements the hard parts
 * once, EPIC-015 adds the configuration and secret rules. None of that stops a
 * provider from initializing twice under a race, throwing from a second
 * `shutdown`, or writing its own token into a log line — and every one of those
 * is checkable from outside the provider, by anyone, without reading its source.
 *
 * The suite returns data. It deliberately depends on no test framework: a
 * provider author asserts on the report in whatever framework they already use,
 * and a report can be diffed between versions because every check id is stable.
 *
 * What it does *not* check is behaviour: that a repository provider actually
 * discovers repositories belongs to the capability's own suite. This is the
 * contract, and only the contract.
 */

export type ConformanceStatus = 'pass' | 'fail' | 'skipped';

export interface ConformanceCheck {
  /** Stable across versions, so reports can be compared. */
  readonly id: string;
  readonly title: string;
  readonly status: ConformanceStatus;
  /** Why it passed, failed or did not apply. Never contains a secret. */
  readonly detail: string;
}

export interface ConformanceReport {
  readonly providerId: string;
  readonly checks: readonly ConformanceCheck[];
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  /** True when nothing failed. Skipped checks do not make a provider deficient. */
  readonly conformant: boolean;
}

export interface ConformanceOptions {
  /**
   * Builds a fresh provider.
   *
   * A factory rather than an instance because EPIC-012 makes a stopped provider
   * unrevivable, so the idempotency and concurrency scenarios each need their
   * own. Reusing one instance would test the harness, not the provider.
   */
  readonly create: () => Provider;
  /**
   * Options the provider is given, before the suite plants its canaries.
   *
   * Supply whatever the provider's own schema requires; the suite adds to it
   * rather than replacing it, and skips the secret checks if the result no
   * longer validates.
   */
  readonly options?: Readonly<Record<string, unknown>>;
  /** Base configuration. Defaults to Ferret's defaults with a canary password. */
  readonly config?: FerretConfig;
  /**
   * Skip the scenarios that drive `initialize`.
   *
   * For a provider whose initialization requires an external system that is not
   * available where the suite is running. The declaration checks still run.
   */
  readonly offline?: boolean;
}

/** Every check the runner can emit, in report order. */
export const CONFORMANCE_CHECK_IDS: readonly string[] = Object.freeze([
  'contract.id',
  'contract.kind',
  'contract.version',
  'contract.capabilities',
  'contract.registers',
  'contract.selectable',
  'config.schema.total',
  'config.secretOptions.paths',
  'lifecycle.initialize',
  'lifecycle.initialize.idempotent',
  'lifecycle.initialize.concurrent',
  'lifecycle.shutdown.bare',
  'lifecycle.shutdown.idempotent',
  'lifecycle.shutdown.afterAbort',
  'lifecycle.errors.classified',
  'dependencies.shape',
  'security.secrets.notLogged',
  'security.secrets.notThrown',
  'security.config.notLogged',
]);

const TITLES: Readonly<Record<string, string>> = Object.freeze({
  'contract.id': 'The provider id is a valid dotted identifier',
  'contract.kind': 'The provider declares a known kind',
  'contract.version': 'The contract version is one this runtime supports',
  'contract.capabilities': 'Capability declarations are valid and not repeated',
  'contract.registers': 'The provider registers in a fresh registry',
  'contract.selectable': 'The provider is selected for every capability it declares',
  'config.schema.total': 'A declared configSchema returns a verdict rather than throwing',
  'config.secretOptions.paths': 'Declared secret option paths are usable paths',
  'lifecycle.initialize': 'initialize completes',
  'lifecycle.initialize.idempotent': 'A second initialize does not throw',
  'lifecycle.initialize.concurrent': 'Concurrent initialize calls do not throw',
  'lifecycle.shutdown.bare': 'shutdown tolerates never having been initialized',
  'lifecycle.shutdown.idempotent': 'A second shutdown does not throw',
  'lifecycle.shutdown.afterAbort': 'shutdown completes after the context is aborted',
  'lifecycle.errors.classified': 'A failure from initialize is a classified FerretError',
  'dependencies.shape': 'checkDependencies returns well-formed results',
  'security.secrets.notLogged': 'No declared secret option reaches the log',
  'security.secrets.notThrown': 'No declared secret option reaches a thrown error',
  'security.config.notLogged': 'The database password does not reach the log',
});

const DEPENDENCY_STATUSES: ReadonlySet<string> = new Set(Object.values(DependencyStatus));

class Recorder {
  readonly #checks = new Map<string, ConformanceCheck>();

  record(id: string, status: ConformanceStatus, detail: string): void {
    // First result wins. A later scenario that touches the same invariant must
    // not quietly overwrite a failure with a pass from an easier path.
    if (this.#checks.has(id) && this.#checks.get(id)?.status === 'fail') return;
    this.#checks.set(id, { id, title: TITLES[id] ?? id, status, detail });
  }

  pass(id: string, detail = 'ok'): void {
    this.record(id, 'pass', detail);
  }

  fail(id: string, detail: string): void {
    this.#checks.set(id, { id, title: TITLES[id] ?? id, status: 'fail', detail });
  }

  skip(id: string, detail: string): void {
    this.record(id, 'skipped', detail);
  }

  /** Anything the run never reached is skipped, so the report is always complete. */
  finish(providerId: string, reason: string): ConformanceReport {
    const checks = CONFORMANCE_CHECK_IDS.map(
      (id) =>
        this.#checks.get(id) ?? { id, title: TITLES[id] ?? id, status: 'skipped' as const, detail: reason },
    );
    const count = (status: ConformanceStatus): number =>
      checks.filter((check) => check.status === status).length;
    const failed = count('fail');
    return {
      providerId,
      checks,
      passed: count('pass'),
      failed,
      skipped: count('skipped'),
      conformant: failed === 0,
    };
  }
}

/** Runs a lifecycle hook whose failure another check already reports. */
async function quietly(run: () => Promise<void> | void): Promise<void> {
  try {
    await run();
  } catch {
    // Deliberately ignored: the scenario that owns this failure reports it.
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Everything a thrown value carries that could hold a planted canary. */
function serializeThrown(error: unknown): string {
  if (error === undefined) return '';
  const ferret = error instanceof FerretError ? error : undefined;
  return JSON.stringify({
    message: messageOf(error),
    details: ferret?.details,
    remediation: ferret?.remediation,
    stack: error instanceof Error ? error.stack : undefined,
  });
}

/** `Array.isArray` widens a typed value to `any[]`; this keeps the element unknown. */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep-sets a dotted path, creating the objects along the way. */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let cursor = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    if (segment === undefined) return;
    const existing = cursor[segment];
    const next = isRecord(existing) ? { ...existing } : {};
    cursor[segment] = next;
    cursor = next;
  }
  const leaf = segments[segments.length - 1];
  if (leaf !== undefined) cursor[leaf] = value;
}

interface Scenario {
  readonly provider: Provider;
  readonly context: ProviderContext;
  readonly logger: CapturingLogger;
  readonly abort: () => void;
}

/**
 * Runs the conformance suite against a provider.
 *
 * Every scenario builds a fresh provider from `create()`, so a failure in one
 * cannot make another fail for the wrong reason.
 */
export async function runConformance(options: ConformanceOptions): Promise<ConformanceReport> {
  const recorder = new Recorder();
  const probe = options.create();
  const providerId = typeof probe?.id === 'string' ? probe.id : '(unknown)';

  checkDeclaration(recorder, probe);

  // A canary per sink, so a leak names which one it came from and two leaks are
  // never confused for each other.
  const canaries = {
    password: `canary-${randomUUID()}`,
    secret: `canary-${randomUUID()}`,
  };

  // With no configuration of its own, the suite plants a canary password so the
  // "did it log the password" check has something to look for. With a caller's
  // configuration it searches for *that* password instead — substituting one
  // would make the check pass by construction, which is worse than skipping it.
  const baseConfig =
    options.config ??
    parseConfig({
      database: { host: 'localhost', database: 'ferret', user: 'ferret', password: canaries.password },
    });
  const passwordProbe = options.config === undefined ? canaries.password : baseConfig.database.password;

  const secretPaths = (probe.secretOptions ?? []).filter(
    (path) => typeof path === 'string' && path.length > 0,
  );
  const plantedOptions: Record<string, unknown> = { ...(options.options ?? {}) };
  for (const path of secretPaths) setPath(plantedOptions, path, canaries.secret);

  // A provider whose id the schema would reject cannot have a configuration
  // entry at all; it has already failed `contract.id`, and building one would
  // fail configuration parsing instead of reporting the provider's defect.
  const idUsable = typeof probe?.id === 'string' && PROVIDER_ID_PATTERN.test(probe.id);
  const config = idUsable
    ? parseConfig({
        ...baseConfig,
        providers: { ...baseConfig.providers, [providerId]: { enabled: true, options: plantedOptions } },
      })
    : baseConfig;

  let settings: ProviderSettings | undefined;
  let settingsError: string | undefined;
  try {
    settings = providerSettings(probe, config);
  } catch (error) {
    settingsError = messageOf(error);
  }

  checkRegistration(recorder, options.create);

  if (options.offline === true) {
    return recorder.finish(providerId, 'skipped: the suite was run offline');
  }
  if (settings === undefined) {
    // The planted canary broke the provider's own schema. Everything from here
    // needs a context, and a context needs settings, so the rest is honestly
    // unproven rather than passed.
    return recorder.finish(
      providerId,
      `skipped: the provider's configSchema rejected the options the suite planted (${settingsError ?? 'unknown'}). Pass valid \`options\` to runConformance.`,
    );
  }

  const scenario = (): Scenario => {
    const logger = new CapturingLogger();
    const provider = options.create();
    // Granted the way the registry grants — EPIC-081 §8.1 — so a provider that
    // declares a credential is still probed for leaking it, and one that
    // declares none cannot leak what it never received.
    const context = createTestProviderContext({
      config,
      logger,
      settings,
      credentials: credentialsFor(config, provider.credentials ?? []),
    });
    return {
      provider,
      context,
      logger,
      abort: (): void => {
        context.abort();
      },
    };
  };

  await checkLifecycle(recorder, scenario);
  await checkDependencies(recorder, scenario);
  await checkSecrets(recorder, scenario, secretPaths, canaries.secret, passwordProbe);

  return recorder.finish(providerId, 'skipped: the check was not reached');
}

function checkDeclaration(recorder: Recorder, provider: Provider): void {
  if (typeof provider?.id === 'string' && PROVIDER_ID_PATTERN.test(provider.id)) {
    recorder.pass('contract.id', provider.id);
  } else {
    recorder.fail('contract.id', `"${String(provider?.id)}" is not a lowercase dotted identifier`);
  }

  if (isProviderKind(provider?.kind)) {
    recorder.pass('contract.kind', provider.kind);
  } else {
    recorder.fail('contract.kind', `"${String(provider?.kind)}" is not a known provider kind`);
  }

  if (isSupportedContractVersion(provider?.contractVersion)) {
    recorder.pass('contract.version', String(provider.contractVersion));
  } else {
    recorder.fail(
      'contract.version',
      `declares ${String(provider?.contractVersion)}; this runtime supports ${MINIMUM_PROVIDER_CONTRACT_VERSION}–${PROVIDER_CONTRACT_VERSION}`,
    );
  }

  const declarations = provider?.capabilities ?? [];
  const seen = new Set<Capability>();
  const problems: string[] = [];
  for (const declaration of declarations) {
    try {
      validateCapabilityDeclaration(provider.id, declaration);
    } catch (error) {
      problems.push(messageOf(error));
      continue;
    }
    if (seen.has(declaration.capability)) {
      problems.push(`capability "${declaration.capability}" is declared more than once`);
    }
    seen.add(declaration.capability);
  }
  if (problems.length > 0) {
    recorder.fail('contract.capabilities', problems.join('; '));
  } else if (declarations.length === 0) {
    recorder.skip('contract.capabilities', 'the provider declares no capabilities');
  } else {
    recorder.pass('contract.capabilities', `${String(declarations.length)} valid declaration(s)`);
  }

  checkConfigDeclaration(recorder, provider);
}

function checkConfigDeclaration(recorder: Recorder, provider: Provider): void {
  if (provider?.configSchema === undefined) {
    recorder.skip('config.schema.total', 'the provider declares no configSchema');
  } else {
    try {
      // A schema is a verdict function: it may reject `{}`, but it must not
      // throw, or every caller has to wrap it and the failure is unclassified.
      provider.configSchema.safeParse({});
      recorder.pass('config.schema.total', 'safeParse({}) returned a verdict');
    } catch (error) {
      recorder.fail('config.schema.total', `safeParse({}) threw: ${messageOf(error)}`);
    }
  }

  const declared = provider?.secretOptions;
  if (declared === undefined || declared.length === 0) {
    recorder.skip('config.secretOptions.paths', 'the provider declares no secret options');
    return;
  }
  const bad = declared.filter(
    (path) =>
      typeof path !== 'string' ||
      path.length === 0 ||
      path.split('.').some((segment) => segment.length === 0),
  );
  if (bad.length > 0) {
    recorder.fail(
      'config.secretOptions.paths',
      `not usable option paths: ${bad.map((path) => JSON.stringify(path)).join(', ')}`,
    );
  } else {
    recorder.pass('config.secretOptions.paths', declared.join(', '));
  }
}

function checkRegistration(recorder: Recorder, create: () => Provider): void {
  const registry = new ProviderRegistry();
  const provider = create();
  try {
    registry.register(provider);
    recorder.pass('contract.registers');
  } catch (error) {
    recorder.fail('contract.registers', messageOf(error));
    recorder.skip('contract.selectable', 'the provider did not register');
    return;
  }

  const declared = provider.capabilities ?? [];
  if (declared.length === 0) {
    recorder.skip('contract.selectable', 'the provider declares no capabilities');
    return;
  }
  // Selection is indexed at registration, so this needs no initialization —
  // which matters, because a provider whose external system is absent must
  // still be reachable for a capability it declares.
  const missing = declared
    .map((declaration) => declaration.capability)
    .filter((capability) => registry.forCapability(capability)?.id !== provider.id);
  if (missing.length > 0) {
    recorder.fail('contract.selectable', `not selected for: ${missing.join(', ')}`);
  } else {
    recorder.pass('contract.selectable', `${String(declared.length)} capability(ies)`);
  }
}

async function checkLifecycle(recorder: Recorder, scenario: () => Scenario): Promise<void> {
  const first = scenario();
  let initializeError: unknown;
  try {
    await first.provider.initialize?.(first.context);
    recorder.pass('lifecycle.initialize');
  } catch (error) {
    initializeError = error;
    recorder.fail('lifecycle.initialize', messageOf(error));
  }

  if (initializeError === undefined) {
    recorder.skip('lifecycle.errors.classified', 'initialize did not fail');
  } else if (initializeError instanceof FerretError) {
    recorder.pass('lifecycle.errors.classified', initializeError.code);
  } else {
    recorder.fail(
      'lifecycle.errors.classified',
      `threw ${initializeError instanceof Error ? initializeError.constructor.name : typeof initializeError}, not a FerretError with a code and remediation`,
    );
  }

  // Second initialize on the *same* instance: the contract says a provider is
  // initialized once, and the common bug is a second call opening a second
  // pool or throwing.
  try {
    await first.provider.initialize?.(first.context);
    recorder.pass('lifecycle.initialize.idempotent');
  } catch (error) {
    recorder.fail('lifecycle.initialize.idempotent', messageOf(error));
  }

  const racy = scenario();
  try {
    await Promise.all([
      racy.provider.initialize?.(racy.context),
      racy.provider.initialize?.(racy.context),
    ]);
    recorder.pass('lifecycle.initialize.concurrent');
  } catch (error) {
    recorder.fail('lifecycle.initialize.concurrent', messageOf(error));
  }
  await quietly(() => racy.provider.shutdown?.());

  const bare = scenario();
  try {
    await bare.provider.shutdown?.();
    recorder.pass('lifecycle.shutdown.bare');
  } catch (error) {
    recorder.fail('lifecycle.shutdown.bare', messageOf(error));
  }

  try {
    await first.provider.shutdown?.();
    await first.provider.shutdown?.();
    recorder.pass('lifecycle.shutdown.idempotent');
  } catch (error) {
    recorder.fail('lifecycle.shutdown.idempotent', messageOf(error));
  }

  // Shutdown is what runs *because* the runtime is stopping, so an aborted
  // signal is its normal condition rather than an edge case.
  const aborted = scenario();
  try {
    await aborted.provider.initialize?.(aborted.context);
  } catch {
    // Initialization failure is already reported; this scenario is about
    // shutting down cleanly afterwards either way.
  }
  aborted.abort();
  try {
    await aborted.provider.shutdown?.();
    recorder.pass('lifecycle.shutdown.afterAbort');
  } catch (error) {
    recorder.fail('lifecycle.shutdown.afterAbort', messageOf(error));
  }
}

async function checkDependencies(recorder: Recorder, scenario: () => Scenario): Promise<void> {
  const { provider, context } = scenario();
  if (provider.checkDependencies === undefined) {
    recorder.skip('dependencies.shape', 'the provider does not implement checkDependencies');
    return;
  }

  let results: readonly DependencyCheckResult[];
  try {
    await provider.initialize?.(context);
    results = await provider.checkDependencies(context);
  } catch (error) {
    recorder.fail('dependencies.shape', `checkDependencies threw: ${messageOf(error)}`);
    return;
  } finally {
    await quietly(() => provider.shutdown?.());
  }

  if (!isUnknownArray(results)) {
    recorder.fail('dependencies.shape', `returned ${typeof results}, not an array of results`);
    return;
  }
  const problems: string[] = [];
  results.forEach((entry, index) => {
    const result = isRecord(entry) ? entry : undefined;
    const name = result?.['name'];
    if (typeof name !== 'string' || name.length === 0) {
      problems.push(`[${String(index)}] has no name`);
    }
    if (!DEPENDENCY_STATUSES.has(String(result?.['status']))) {
      problems.push(`[${String(index)}] status "${String(result?.['status'])}" is not a DependencyStatus`);
    }
    if (typeof result?.['required'] !== 'boolean') {
      problems.push(`[${String(index)}] does not say whether it is required`);
    }
  });
  if (problems.length > 0) {
    recorder.fail('dependencies.shape', problems.join('; '));
  } else {
    recorder.pass('dependencies.shape', `${String(results.length)} well-formed result(s)`);
  }
}

async function checkSecrets(
  recorder: Recorder,
  scenario: () => Scenario,
  secretPaths: readonly string[],
  secretCanary: string,
  passwordProbe: string | undefined,
): Promise<void> {
  const { provider, context, logger, abort } = scenario();
  let thrown: unknown;
  try {
    await provider.initialize?.(context);
    await provider.checkDependencies?.(context);
  } catch (error) {
    thrown = error;
  }
  abort();
  try {
    await provider.shutdown?.();
  } catch (error) {
    thrown ??= error;
  }

  const logged = logger.dump();
  const errorText = serializeThrown(thrown);
  const named = secretPaths.length === 0 ? '' : secretPaths.join(', ');

  if (secretPaths.length === 0) {
    recorder.skip('security.secrets.notLogged', 'the provider declares no secret options');
    recorder.skip('security.secrets.notThrown', 'the provider declares no secret options');
  } else if (logged.includes(secretCanary)) {
    // The path, never the value: a conformance report is something people paste
    // into an issue.
    recorder.fail(
      'security.secrets.notLogged',
      `a value the provider declared secret (${named}) was written to the log`,
    );
  } else {
    recorder.pass('security.secrets.notLogged', named);
  }

  if (secretPaths.length > 0) {
    if (errorText.includes(secretCanary)) {
      recorder.fail(
        'security.secrets.notThrown',
        `a value the provider declared secret (${named}) appears in an error it threw`,
      );
    } else {
      recorder.pass('security.secrets.notThrown', named);
    }
  }

  if (passwordProbe === undefined || passwordProbe.length === 0) {
    recorder.skip('security.config.notLogged', 'the supplied configuration has no database password');
  } else if (logged.includes(passwordProbe) || errorText.includes(passwordProbe)) {
    recorder.fail(
      'security.config.notLogged',
      'the configured database password appears in the log or in an error the provider threw',
    );
  } else {
    recorder.pass('security.config.notLogged');
  }
}

/**
 * Throws unless the report is conformant.
 *
 * @throws {FerretError} `E_PROVIDER_INVALID` naming every failed check, so one
 * run reports every problem rather than the first.
 */
export function assertConformant(report: ConformanceReport): void {
  if (report.conformant) return;
  const failures = report.checks.filter((check) => check.status === 'fail');
  throw new FerretError(
    ErrorCode.PROVIDER_INVALID,
    `Provider "${report.providerId}" is not conformant — ${failures
      .map((check) => `${check.id}: ${check.detail}`)
      .join('; ')}`,
    {
      details: {
        providerId: report.providerId,
        failed: failures.map((check) => ({ id: check.id, detail: check.detail })),
      },
      remediation:
        'Fix the listed checks. Each id names one invariant of the provider contract; see docs/EPICs/EPIC-016-Provider-Conformance-Testing.md.',
    },
  );
}
