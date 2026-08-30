import { MINIMUM_NODE_MAJOR } from '../environment/index.js';

import {
  DependencyStatus,
  type DependencyCheck,
  type DependencyCheckContext,
  type DependencyCheckResult,
} from './contract.js';

/**
 * Node.js must satisfy the range declared in `engines`. This is required:
 * running on an unsupported runtime produces failures that look like Ferret
 * defects, so the runtime refuses to become ready instead.
 */
export const nodeVersionCheck: DependencyCheck = {
  name: 'node-version',
  required: true,
  run({ environment }: DependencyCheckContext): DependencyCheckResult {
    if (environment.node.supported) {
      return {
        name: 'node-version',
        status: DependencyStatus.OK,
        required: true,
        detail: `Node.js ${environment.node.version}`,
      };
    }
    return {
      name: 'node-version',
      status: DependencyStatus.UNAVAILABLE,
      required: true,
      detail: `Node.js ${environment.node.version} is below the supported range ${environment.node.supportedRange}`,
      remediation: `Install Node.js ${MINIMUM_NODE_MAJOR} LTS or newer and reinstall Ferret.`,
    };
  },
};

/**
 * Git is required by source discovery (EPIC-017) but not by the core runtime,
 * so its absence is reported as degraded rather than blocking startup.
 */
export const gitAvailableCheck: DependencyCheck = {
  name: 'git',
  required: false,
  run({ environment }: DependencyCheckContext): DependencyCheckResult {
    if (environment.git.available) {
      return {
        name: 'git',
        status: DependencyStatus.OK,
        required: false,
        detail: environment.git.version === undefined ? 'git found' : `git ${environment.git.version}`,
      };
    }
    return {
      name: 'git',
      status: DependencyStatus.DEGRADED,
      required: false,
      detail: 'git executable was not found on PATH',
      remediation: 'Install Git and ensure it is on PATH. Repository features stay unavailable until it is.',
    };
  },
};

/** Checks the runtime performs on every start. */
export const CORE_DEPENDENCY_CHECKS: readonly DependencyCheck[] = [nodeVersionCheck, gitAvailableCheck];
