import { Command } from 'commander';

import {
  ConfigStore,
  DEFAULT_EXCLUSIONS,
  ExclusionScope,
  auditLogPath,
  defaultConfigSources,
  describeConfig,
  effectiveExclusions,
  evaluateExclusion,
  findRepositoryConfig,
  getAt,
  isSecretKey,
  parsePath,
  readAudit,
  resolveConfig,
  userConfigPath,
  type ExclusionRule,
  type RepositoryPolicy,
} from '../../index.js';
import { REDACTED } from '../../errors/index.js';
import { emitResult, type OutputOptions } from '../output.js';

/**
 * `ferret config` — inspect and change configuration.
 *
 * This is the surface Governance §16 requires to be reachable by the AI control
 * plane: every subcommand emits structured JSON under `--json`, so EPIC-066 can
 * expose it as MCP tools without a second implementation.
 *
 * Reads never mutate and writes are validated before they take effect, so an
 * agent cannot leave configuration in a state that stops Ferret from starting.
 * Secrets are rendered through the same redaction as everywhere else, and
 * `config get` refuses to print a secret at all.
 */

interface Globals {
  readonly json?: boolean;
}

function storeFor(options: { config?: string }): ConfigStore {
  return options.config === undefined ? new ConfigStore() : new ConfigStore({ path: options.config });
}

/**
 * Parses a value the way a user means it.
 *
 * `true`, `5432` and `["a","b"]` are read as their JSON types; anything that is
 * not valid JSON stays a string, so a password containing punctuation does not
 * have to be quoted twice.
 */
export function parseValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return raw;
  if (!/^[[{"]|^-?\d|^true$|^false$|^null$/.test(trimmed)) return raw;
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

function resolved(options: { config?: string }) {
  const policies: RepositoryPolicy[] = [];
  const { sources } = defaultConfigSources({
    ...(options.config === undefined ? {} : { configPath: options.config }),
    onRepositoryPolicy: (policy) => policies.push(policy),
  });
  return { ...resolveConfig(sources), policies };
}

function listCommand(output: (json: boolean) => OutputOptions): Command {
  return new Command('list')
    .alias('ls')
    .description('Show the effective configuration, with secrets redacted')
    .option('--explain', 'Also report which layer supplied each value', false)
    .option('--config <path>', 'Read this configuration file instead of the default')
    .action((options: { explain: boolean; config?: string }, command: Command) => {
      const json = command.optsWithGlobals<Globals>().json === true;
      const { config, sources, origins, policies } = resolved(options);

      const payload = {
        config: describeConfig(config),
        sources,
        ...(options.explain ? { origins } : {}),
        files: {
          user: options.config ?? userConfigPath(),
          repository: findRepositoryConfig() ?? null,
          audit: auditLogPath(),
        },
        // A repository that tried to set something it may not is worth
        // surfacing: silence would leave its author guessing.
        repositoryIgnoredKeys: policies.flatMap((policy) => policy.ignored),
      };

      emitResult(output(json), payload, () => {
        const lines: string[] = [];
        const walk = (value: unknown, prefix: string): void => {
          if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            for (const [key, entry] of Object.entries(value)) {
              walk(entry, prefix === '' ? key : `${prefix}.${key}`);
            }
            return;
          }
          const rendered = Array.isArray(value) ? JSON.stringify(value) : String(value);
          const origin = options.explain ? `  ← ${origins[prefix] ?? 'default'}` : '';
          lines.push(`${prefix.padEnd(28)}${rendered}${origin}`);
        };
        walk(payload.config, '');
        lines.push('');
        lines.push(`user config       ${payload.files.user}`);
        lines.push(`repository policy ${payload.files.repository ?? '(none)'}`);
        if (payload.repositoryIgnoredKeys.length > 0) {
          lines.push(
            `ignored from repository policy: ${payload.repositoryIgnoredKeys.join(', ')} (a repository may only set exclusions)`,
          );
        }
        return lines.join('\n');
      });
    });
}

function getCommand(output: (json: boolean) => OutputOptions): Command {
  return new Command('get')
    .description('Read one configuration value by dotted path')
    .argument('<path>', 'Dotted path, e.g. database.host')
    .option('--config <path>', 'Read this configuration file instead of the default')
    .action((path: string, options: { config?: string }, command: Command) => {
      const json = command.optsWithGlobals<Globals>().json === true;
      const segments = parsePath(path);
      const { config, origins } = resolved(options);

      // Redaction by key name, applied here rather than after rendering: a
      // caller must not be able to extract a password one path at a time.
      const leaf = segments.at(-1) ?? path;
      const secret = isSecretKey(leaf);
      const value = getAt(config, segments);

      emitResult(
        output(json),
        {
          path,
          value: secret && value !== undefined ? REDACTED : value ?? null,
          redacted: secret && value !== undefined,
          source: origins[path] ?? 'default',
        },
        () => {
          if (value === undefined) return `${path} is not set`;
          if (secret) return REDACTED;
          // Everything that is not a primitive is rendered as JSON, so a nested
          // object never reaches the terminal as "[object Object]".
          return typeof value === 'string' ? value : JSON.stringify(value);
        },
      );
    });
}

function setCommand(output: (json: boolean) => OutputOptions): Command {
  return new Command('set')
    .description('Store one configuration value')
    .argument('<path>', 'Dotted path, e.g. database.host')
    .argument('<value>', 'JSON value, or plain text when it is not valid JSON')
    .option('--config <path>', 'Write this configuration file instead of the default')
    .action((path: string, raw: string, options: { config?: string }, command: Command) => {
      const json = command.optsWithGlobals<Globals>().json === true;
      const result = storeFor(options).set(path, parseValue(raw));

      emitResult(
        output(json),
        {
          path,
          stored: true,
          file: result.path,
          redacted: isSecretKey(path.split('.').at(-1) ?? path),
          auditWritten: result.auditError === undefined,
        },
        () => `${path} saved to ${result.path}`,
      );
    });
}

function unsetCommand(output: (json: boolean) => OutputOptions): Command {
  return new Command('unset')
    .description('Remove one stored configuration value, restoring its default')
    .argument('<path>', 'Dotted path, e.g. database.host')
    .option('--config <path>', 'Write this configuration file instead of the default')
    .action((path: string, options: { config?: string }, command: Command) => {
      const json = command.optsWithGlobals<Globals>().json === true;
      const result = storeFor(options).unset(path);
      emitResult(output(json), { path, removed: true, file: result.path }, () =>
        `${path} removed from ${result.path}`,
      );
    });
}

function validateCommand(output: (json: boolean) => OutputOptions): Command {
  return new Command('validate')
    .description('Check that the effective configuration is usable, changing nothing')
    .option('--config <path>', 'Validate this configuration file instead of the default')
    .action((options: { config?: string }, command: Command) => {
      const json = command.optsWithGlobals<Globals>().json === true;
      // resolveConfig throws E_CONFIG_INVALID with the offending paths, which
      // the CLI turns into exit code 3. Reaching here means it is valid.
      const { config, sources } = resolved(options);
      emitResult(
        output(json),
        { valid: true, sources, exclusions: effectiveExclusions(config).length },
        () => 'Configuration is valid.',
      );
    });
}

function pathCommand(output: (json: boolean) => OutputOptions): Command {
  return new Command('path')
    .description('Print the files Ferret reads configuration from')
    .action((_options: unknown, command: Command) => {
      const json = command.optsWithGlobals<Globals>().json === true;
      const payload = {
        user: userConfigPath(),
        repository: findRepositoryConfig() ?? null,
        audit: auditLogPath(),
      };
      emitResult(output(json), payload, () =>
        [
          `user        ${payload.user}`,
          `repository  ${payload.repository ?? '(none)'}`,
          `audit       ${payload.audit}`,
        ].join('\n'),
      );
    });
}

function excludeCommand(output: (json: boolean) => OutputOptions): Command {
  const exclude = new Command('exclude').description('Inspect and test indexing exclusions');

  exclude
    .command('list')
    .description('Show every exclusion rule that applies, and where it came from')
    .option('--config <path>', 'Read this configuration file instead of the default')
    .action((options: { config?: string }, command: Command) => {
      const json = command.optsWithGlobals<Globals>().json === true;
      const { config } = resolved(options);
      const rules = effectiveExclusions(config);
      const isDefault = (rule: ExclusionRule): boolean =>
        DEFAULT_EXCLUSIONS.some((entry) => entry.pattern === rule.pattern && entry.scope === rule.scope);

      const payload = rules.map((rule) => ({
        pattern: rule.pattern,
        scope: rule.scope,
        reason: rule.reason ?? null,
        effectiveFrom: rule.effectiveFrom ?? null,
        builtIn: isDefault(rule),
      }));

      emitResult(output(json), payload, () =>
        payload
          .map(
            (rule) =>
              `${rule.builtIn ? 'default ' : 'user    '}${rule.pattern.padEnd(20)}${rule.scope.padEnd(12)}${rule.reason ?? ''}`,
          )
          .join('\n'),
      );
    });

  exclude
    .command('test')
    .description('Report whether a path would be excluded, and by which rule')
    .argument('<path>', 'Repository-relative path to test')
    .option('--at <iso>', 'Evaluate as policy stood at this instant')
    .option('--config <path>', 'Read this configuration file instead of the default')
    .action((path: string, options: { at?: string; config?: string }, command: Command) => {
      const json = command.optsWithGlobals<Globals>().json === true;
      const { config } = resolved(options);
      const at = options.at === undefined ? undefined : new Date(options.at);
      const decision = evaluateExclusion(path, effectiveExclusions(config), at === undefined ? {} : { at });

      emitResult(
        output(json),
        {
          path,
          excluded: decision.excluded,
          rule: decision.rule === undefined ? null : { ...decision.rule, reason: decision.rule.reason ?? null },
          // Stated explicitly because it is the property EPIC-003 is required
          // to preserve: an exclusion never removes what is already indexed.
          note: 'An exclusion governs indexing and retrieval. It never deletes evidence already recorded.',
        },
        () =>
          decision.excluded
            ? `${path} is excluded by "${decision.rule?.pattern ?? '?'}" (${decision.rule?.scope ?? ExclusionScope.GLOBAL})${decision.rule?.reason === undefined ? '' : ` — ${decision.rule.reason}`}`
            : `${path} is not excluded`,
      );
    });

  return exclude;
}

function auditCommand(output: (json: boolean) => OutputOptions): Command {
  return new Command('audit')
    .description('Show the configuration change journal')
    .option('-n, --limit <count>', 'Show only the most recent entries', (value) => Number(value))
    .action((options: { limit?: number }, command: Command) => {
      const json = command.optsWithGlobals<Globals>().json === true;
      const all = readAudit();
      const entries =
        options.limit === undefined || Number.isNaN(options.limit) ? all : all.slice(-Math.max(0, options.limit));

      emitResult(output(json), entries, () =>
        entries.length === 0
          ? 'No configuration changes have been recorded.'
          : entries
              .map((entry) => `${entry.at}  ${entry.action.padEnd(8)}${entry.path.padEnd(24)}${entry.actor}`)
              .join('\n'),
      );
    });
}

export function configCommand(output: (json: boolean) => OutputOptions): Command {
  const config = new Command('config').description(
    'Inspect and change Ferret configuration',
  );

  config.addCommand(listCommand(output), { isDefault: true });
  config.addCommand(getCommand(output));
  config.addCommand(setCommand(output));
  config.addCommand(unsetCommand(output));
  config.addCommand(validateCommand(output));
  config.addCommand(pathCommand(output));
  config.addCommand(excludeCommand(output));
  config.addCommand(auditCommand(output));

  return config;
}
