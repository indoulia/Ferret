export {
  CONFIG_FILE_VERSION,
  DEFAULT_DATABASE_PORT,
  REQUIRED_DATABASE_FIELDS,
  databaseConfigSchema,
  effectiveExclusions,
  ferretConfigSchema,
  isDatabaseConfigured,
  missingDatabaseFields,
  providerConfigSchema,
  providersConfigSchema,
  type DatabaseConfig,
  type FerretConfig,
  type ProviderConfig,
} from './schema.js';

export { describeConfigProtection, type ConfigProtection } from './at-rest.js';
export {
  CREDENTIAL_CONFIG_PATHS,
  credentialsFor,
  withoutCredentialFields,
  type ProviderVisibleConfig,
} from './credentials.js';

export {
  ConfigPrecedence,
  ENV_BINDINGS,
  ENV_PREFIX,
  describeConfig,
  environmentSource,
  parseConfig,
  resolveConfig,
  type ConfigSource,
  type DescribeConfigOptions,
  type ResolveOptions,
  type ResolvedConfig,
} from './resolve.js';

export {
  CONFIG_DIRECTORY_NAME,
  CONFIG_FILE_ENV,
  CONFIG_FILE_NAME,
  CONFIG_HOME_ENV,
  REPOSITORY_CONFIG_DIRECTORY,
  auditLogPath,
  configHome,
  findRepositoryConfig,
  userConfigPath,
} from './paths.js';

export {
  SECRET_REF_KEY,
  describeSecretRef,
  isSecretRef,
  registerSecretResolver,
  resolveSecretRef,
  resolveSecrets,
  secretResolverFor,
  secretResolverSources,
  type ResolveSecretsOptions,
  type SecretRef,
  type SecretRefBody,
  type SecretResolver,
  type SecretResolverContext,
} from './secret-ref.js';

export {
  DEFAULT_EXCLUSIONS,
  ExclusionScope,
  evaluateExclusion,
  exclusionInputSchema,
  exclusionRuleSchema,
  isExcluded,
  mergeExclusions,
  normalizePath,
  type EvaluateOptions,
  type ExclusionDecision,
  type ExclusionRule,
} from './exclusions.js';

export {
  parseConfigFile,
  readConfigFile,
  userFileSource,
  type ConfigFile,
} from './file-source.js';

export {
  REPOSITORY_ALLOWED_KEYS,
  filterRepositoryFragment,
  repositorySource,
  type RepositoryPolicy,
  type RepositorySourceOptions,
} from './repository-source.js';

export {
  MutableConfigSource,
  explicitSource,
  sessionSource,
  type MutableSourceOptions,
} from './session-source.js';

export {
  defaultConfigSourceList,
  defaultConfigSources,
  type DefaultSources,
  type DefaultSourcesOptions,
} from './sources.js';

export {
  ConfigStore,
  DEFAULT_LOCK_STALE_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  acquireLock,
  getAt,
  parsePath,
  setAt,
  unsetAt,
  validateCandidate,
  writeConfigFileAtomically,
  type ChangeResult,
  type ConfigStoreOptions,
  type LockOptions,
} from './store.js';

export {
  AuditAction,
  appendAudit,
  auditValue,
  buildAuditEntry,
  readAudit,
  type AuditEntry,
  type RecordChangeOptions,
} from './audit.js';
