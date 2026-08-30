/**
 * Ferret core — public entry point.
 *
 * This module is the entire supported surface for embedding Ferret. It exports
 * the runtime, its contracts and its error model.
 *
 * It deliberately imports nothing from `src/cli/**` and nothing provider- or
 * vendor-specific. Providers reach the core through `ProviderRegistry`, never
 * the other way round, so adding GitHub, Jira, a parser or a storage backend
 * never changes what a core consumer depends on. `tests/unit/boundaries.test.ts`
 * enforces this by walking the import graph.
 */

export {
  PACKAGE_NAME,
  RUNTIME_CONTRACT_VERSION,
  SUPPORTED_NODE_RANGE,
  VERSION,
  versionInfo,
  type VersionInfo,
} from './version.js';

export {
  ErrorCode,
  FerretError,
  REDACTED,
  isErrorCode,
  isSecretKey,
  redact,
  redactString,
  serializeError,
  toFerretError,
  type FerretErrorOptions,
  type SerializedError,
} from './errors/index.js';

export {
  LOG_LEVELS,
  createLogger,
  createNullLogger,
  isLogLevel,
  type LogFields,
  type LogLevel,
  type Logger,
  type LoggerOptions,
} from './logging/index.js';

export {
  ConfigPrecedence,
  DEFAULT_DATABASE_PORT,
  ENV_BINDINGS,
  ENV_PREFIX,
  REQUIRED_DATABASE_FIELDS,
  databaseConfigSchema,
  describeConfig,
  environmentSource,
  ferretConfigSchema,
  isDatabaseConfigured,
  missingDatabaseFields,
  parseConfig,
  resolveConfig,
  type ConfigSource,
  type DatabaseConfig,
  type FerretConfig,
  type ResolvedConfig,
} from './config/index.js';

export {
  MINIMUM_NODE_MAJOR,
  detectEnvironment,
  detectGit,
  type EnvironmentReport,
  type GitInfo,
} from './environment/index.js';

export {
  CORE_DEPENDENCY_CHECKS,
  DependencyStatus,
  gitAvailableCheck,
  isHealthy,
  nodeVersionCheck,
  type DependencyCheck,
  type DependencyCheckContext,
  type DependencyCheckResult,
} from './diagnostics/index.js';

export {
  PROVIDER_CONTRACT_VERSION,
  PROVIDER_ID_PATTERN,
  ProviderKind,
  ProviderRegistry,
  describeProvider,
  isProviderKind,
  type Provider,
  type ProviderContext,
  type ProviderDescriptor,
} from './providers/index.js';

export {
  DisposableStack,
  FerretRuntime,
  RuntimeState,
  SHUTDOWN_SIGNALS,
  canTransition,
  createRuntime,
  installSignalHandlers,
  isTerminal,
  type Disposable,
  type RuntimeContext,
  type RuntimeOptions,
  type SignalHandlerOptions,
} from './runtime/index.js';
