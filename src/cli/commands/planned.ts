import { Command } from 'commander';

import { ErrorCode, FerretError } from '../../errors/index.js';

export interface PlannedCommandSpec {
  readonly name: string;
  /** What the command will do once its Epic lands. */
  readonly summary: string;
  /** Epic identifiers that own the capability, e.g. `['EPIC-004']`. */
  readonly owners: readonly string[];
}

/**
 * Commands Ferret's roadmap defines but this release does not implement.
 *
 * They appear in `--help` so the command surface is discoverable and stable,
 * but they are marked `(planned)`, and invoking one fails with
 * `E_NOT_IMPLEMENTED` and exit code 5. Nothing is silently ignored and nothing
 * is falsely advertised as working: EPIC-001 owns the command *structure*, and
 * the named Epic owns the behaviour.
 */
export function plannedCommand(spec: PlannedCommandSpec): Command {
  const owners = spec.owners.join(', ');
  return new Command(spec.name)
    .description(`${spec.summary} (planned — ${owners})`)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .helpOption('-h, --help', 'Show help for this command')
    .action(() => {
      throw new FerretError(
        ErrorCode.NOT_IMPLEMENTED,
        `\`ferret ${spec.name}\` is not implemented in this release`,
        {
          details: { command: spec.name, plannedIn: [...spec.owners] },
          remediation: `This capability is delivered by ${owners}. Run \`ferret --help\` to see what this release supports.`,
        },
      );
    });
}

/** The roadmap command surface, and the Epic that owns each entry. */
/**
 * Commands the roadmap approves and this build does not implement.
 *
 * Was empty as of EPIC-064, when `ferret mcp` moved from planned to served —
 * and stayed empty through the Epics that built the GitHub and Jira providers
 * and the session and memory domain. That is **F-21 and F-20**, and neither is a
 * missing feature: every one of those Epics excluded transport, persistence and
 * a client surface *by name*, and delivered exactly the scope it declared. The
 * modules are real, tested, and reachable as libraries.
 *
 * The defect is the absence of a statement. An operator who has read that Ferret
 * has a GitHub provider has no way to learn that nothing ingests from it, because
 * the only mechanism Ferret has for saying so — this list — was empty, and
 * `ferret sync` answered with an unknown-command error indistinguishable from a
 * typo. The honest answer to "is this coming" is worth more than that, which is
 * what the comment above already said and what these entries finally do.
 *
 * Entries, not implementations. Each fails with `E_NOT_IMPLEMENTED` and names
 * the Epic that owns the behaviour. Building `ferret sync`, a session store, or
 * any transport is explicitly **not** what this is, and the triage ruled it out.
 */
export const PLANNED_COMMANDS: readonly PlannedCommandSpec[] = [
  {
    name: 'sync',
    summary:
      'Ingest issues, pull requests and reviews from a configured external provider. ' +
      'The GitHub and Jira providers exist and are tested as libraries; nothing wires ' +
      'them to a transport or persists what they return',
    owners: ['EPIC-021', 'EPIC-071', 'EPIC-072'],
  },
  {
    name: 'session',
    summary:
      'Record and recall agent sessions and memories. The session and memory model ' +
      'exists and is tested as a library; no store persists it and no command reaches it',
    owners: ['EPIC-039', 'EPIC-040', 'EPIC-041', 'EPIC-042', 'EPIC-043'],
  },
];
