export {
  DependencyStatus,
  isHealthy,
  type DependencyCheck,
  type DependencyCheckContext,
  type DependencyCheckResult,
} from './contract.js';
export { CORE_DEPENDENCY_CHECKS, gitAvailableCheck, nodeVersionCheck } from './checks.js';
