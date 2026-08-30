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
export const PLANNED_COMMANDS: readonly PlannedCommandSpec[] = [
  { name: 'init', summary: 'Provision the database and write initial configuration', owners: ['EPIC-002', 'EPIC-003'] },
  { name: 'config', summary: 'Inspect and change Ferret configuration', owners: ['EPIC-003'] },
  { name: 'status', summary: 'Report health of Ferret, its database and its providers', owners: ['EPIC-004'] },
  { name: 'doctor', summary: 'Diagnose setup problems and suggest remediation', owners: ['EPIC-004'] },
  { name: 'mcp', summary: 'Serve the Model Context Protocol interface to AI clients', owners: ['EPIC-064'] },
];
