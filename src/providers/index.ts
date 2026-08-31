export {
  CAPABILITIES,
  CAPABILITY_VERSIONS,
  Capability,
  CapabilitySupport,
  MINIMUM_CAPABILITY_VERSIONS,
  assertSupported,
  declares,
  describeSupport,
  isCapability,
  isSupportedCapabilityVersion,
  validateCapabilityDeclaration,
  type CapabilityDeclaration,
  type CapabilityLimits,
  type CapabilityVerdict,
} from './capabilities.js';
export {
  MINIMUM_PROVIDER_CONTRACT_VERSION,
  PROVIDER_CONTRACT_VERSION,
  PROVIDER_ID_PATTERN,
  isSupportedContractVersion,
  ProviderKind,
  describeProvider,
  isProviderKind,
  type Provider,
  type ProviderContext,
  type ProviderDescriptor,
} from './contract.js';
export {
  RepositoryIdentityKind,
  RepositoryOperation,
  SkipReason,
  type BranchPage,
  type DiscoveredBranch,
  type DiscoveredRepository,
  type DiscoveredWorktree,
  type RepositoryDiscoveryRequest,
  type RepositoryDiscoveryResult,
  type RepositoryRemote,
  type RepositorySource,
  type SkippedPath,
} from './contracts/source-repository.js';
export {
  discoverProviders,
  providerDiscoveryError,
  type ProviderDiscoveryResult,
  type ProviderDiscoverySkip,
  type ProviderModuleExports,
  type ProviderModuleLoader,
} from './discovery.js';
export { ProviderRegistry } from './registry.js';
export * from './sdk/index.js';

export {
  assertUsable,
  type EmbeddingModel,
  type EmbeddingRequest,
  type EmbeddingResult,
  type EmbeddingSource,
} from './contracts/embedding.js';
