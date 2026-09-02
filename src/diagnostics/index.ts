export {
  DependencyStatus,
  isHealthy,
  type DependencyCheck,
  type DependencyCheckContext,
  type DependencyCheckResult,
} from './contract.js';
export { CORE_DEPENDENCY_CHECKS, gitAvailableCheck, nodeVersionCheck } from './checks.js';

export {
  HealthArea,
  aggregateStatus,
  buildReport,
  componentFrom,
  isUsable,
  summarize,
  worseOf,
  type BuildReportInput,
  type HealthComponent,
  type HealthReport,
} from './health.js';

export {
  DiagnosisSeverity,
  buildDoctorReport,
  countBySeverity,
  diagnose,
  severityOf,
  type Diagnosis,
  type DoctorReport,
} from './doctor.js';

export {
  plannedCapabilityComponents,
  synchronizationComponent,
  type SyncProgress,
  probeCore,
  type CoreProbe,
  type ProbeOptions,
} from './probe.js';
