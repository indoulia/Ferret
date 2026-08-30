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
  { name: 'mcp', summary: 'Serve the Model Context Protocol interface to AI clients', owners: ['EPIC-064'] },
];
