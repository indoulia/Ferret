import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  EffectChange,
  Permission,
  type ConfirmationGate,
  type OperationPlan,
  type Principal,
} from '../authorization/index.js';
import {
  describeConfig,
  effectiveExclusions,
  evaluateExclusion,
  ferretConfigSchema,
  getAt,
  missingDatabaseFields,
  parsePath,
  readAudit,
  type ConfigStore,
  type ResolvedConfig,
} from '../config/index.js';
import { CONTENT_NOTICE } from '../context/index.js';
import { ErrorCode, FerretError, isSecretKey } from '../errors/index.js';
import type { Logger } from '../logging/index.js';

import {
  CONFIRM_PARAMETER_DESCRIPTION,
  createDestructiveToolGuard,
  createToolGuard,
  type ToolGuard,
} from './guards.js';

/**
 * Configuration, over MCP — EPIC-066.
 *
 * Governance says this three times. §1: "normal operation and **configuration**
 * should be performed through the connected AI client". §3: configuration
 * "should be exposed through a discoverable AI interface", and "the CLI remains a
 * bootstrap, health, and emergency-recovery interface". §16: "Configuration must
 * be accessible through the AI control plane."
 *
 * Until this, it was accessible only through the CLI — which inverted §3 and made
 * the AI client the restricted interface. EPIC-059/065's validation said so:
 * "An AI client cannot index, configure or manage providers — only read."
 *
 * **This wraps EPIC-003; it does not reimplement it.** That Epic's validation
 * predicted the shape: "`ferret config` has eight subcommands, all with `--json` …
 * EPIC-066 can wrap these without a second implementation." Every write goes
 * through `ConfigStore`, so the lock, the re-read, the validation, the atomic
 * write and the journal apply identically whether a change came from an AI client
 * or from a terminal. A second write path would be a second set of durability
 * bugs, and EPIC-003 already paid for the first set.
 *
 * `ferret_config_set` and `ferret_config_unset` are the **first destructive tools
 * Ferret has ever had**, which is why EPIC-068 and EPIC-069 came first: one
 * supplies the permission, the other the confirmation, and
 * `createDestructiveToolGuard` is the only path either tool takes.
 */

/**
 * Configuration paths no tool may write.
 *
 * The one rule that makes the rest of the authorization model mean anything. A
 * caller granted `CONFIG_WRITE` must not be able to grant itself `MUTATE`, widen
 * `permittedScopes`, or rename the principal a denial names. Governance §16:
 * "Security restrictions cannot be overridden by lower-trust inputs" — and a
 * grant that can edit itself is not a restriction.
 *
 * Refused by **first segment**, so `authorization`, `authorization.permissions`
 * and `authorization.scope.include` are all refused together. A future security
 * subtree is added here and nowhere else.
 */
const UNWRITABLE_ROOTS: ReadonlySet<string> = new Set(['authorization']);

/** How many journal entries a single call will return. */
const AUDIT_LIMIT = 100;

/**
 * Any JSON value a configuration key can hold.
 *
 * Spelled out rather than `z.unknown()` because this schema is shown to the
 * model: a parameter documented as "unknown" invites a string where an array
 * belongs, and the failure then arrives from the validator rather than from the
 * tool description. `null` is deliberately absent — removing a value is
 * `ferret_config_unset`, and accepting `null` here would give two spellings for
 * one intent, only one of which restores the default.
 */
const configValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

export interface ConfigurationAccess {
  /**
   * The effective configuration, resolved afresh.
   *
   * A function rather than a value: a tool that changed configuration and then
   * reported the configuration as it was at startup would be lying about its own
   * effect.
   */
  readonly resolve: () => ResolvedConfig;
  /** EPIC-003's read-modify-write access. The only writer. */
  readonly store: ConfigStore;
}

export interface ConfigToolDependencies {
  readonly principal: Principal;
  readonly confirmations: ConfirmationGate;
  readonly configuration: ConfigurationAccess;
  readonly logger: Logger;
}

/**
 * Refuses a path this surface may not write, before a plan is built.
 *
 * Before, not after, and for EPIC-069's reason: a plan discloses current values,
 * and disclosing the authorization grant to a caller that is about to be refused
 * would leak the thing being protected in the course of protecting it.
 *
 * @throws {FerretError} `E_NOT_PERMITTED`
 */
function assertWritablePath(segments: readonly string[]): void {
  const root = segments[0];
  if (root === undefined || !UNWRITABLE_ROOTS.has(root)) return;
  throw new FerretError(
    ErrorCode.NOT_PERMITTED,
    `Not permitted: configuration path "${root}" cannot be changed through the AI surface`,
    {
      details: { root, unwritable: [...UNWRITABLE_ROOTS] },
      remediation:
        `"${root}" holds the grant that decides what this client may do, so it is ` +
        'editable only by an operator with access to the configuration file. ' +
        'Use `ferret config set` locally.',
    },
  );
}

/**
 * Refuses a literal secret, naming the form that keeps it out of the transcript.
 *
 * A password arriving as a tool argument is already in the model's context and in
 * whatever transcript the client keeps, so refusing the *write* is late but not
 * pointless: it stops the value reaching the file and the journal, and it teaches
 * the caller the right shape for next time. EPIC-003's secret reference is that
 * shape, and it is why the object form exists.
 *
 * @throws {FerretError} `E_USAGE`
 */
function assertNotLiteralSecret(path: string, segments: readonly string[], value: unknown): void {
  const leaf = segments.at(-1);
  if (leaf === undefined || !isSecretKey(leaf)) return;
  // A secret *reference* is exactly what should be written here, so it passes.
  if (typeof value === 'object' && value !== null && '$secret' in value) return;

  throw new FerretError(ErrorCode.USAGE, `"${path}" holds a credential and takes a secret reference`, {
    details: { path },
    remediation:
      'Do not send the value itself. Store it in an environment variable and set ' +
      'a reference instead, for example: {"$secret":{"env":"FERRET_DATABASE_PASSWORD"}}.',
  });
}

/** What a write to this path would do, disclosed before it does it. */
function planForSet(store: ConfigStore, path: string, segments: readonly string[], value: unknown): OperationPlan {
  // The *stored* document, not the effective configuration. A `set` changes the
  // file, and describing it against a value that came from the environment would
  // disclose a change that is not the change being made.
  const existing = getAt(store.read(), segments);
  return {
    operation: 'config.set',
    summary:
      existing === undefined
        ? `Store a new value for ${path} in Ferret's configuration file.`
        : `Replace the stored value of ${path} in Ferret's configuration file.`,
    effects: [
      {
        target: path,
        change: existing === undefined ? EffectChange.SET : EffectChange.OVERWRITE,
        ...(existing === undefined ? {} : { from: existing }),
        to: value,
      },
    ],
  };
}

function planForUnset(store: ConfigStore, path: string, segments: readonly string[]): OperationPlan {
  const existing = getAt(store.read(), segments);
  return {
    operation: 'config.unset',
    summary: `Remove ${path} from Ferret's configuration file, restoring its default.`,
    effects: [
      {
        target: path,
        change: EffectChange.UNSET,
        ...(existing === undefined ? {} : { from: existing }),
      },
    ],
  };
}

/**
 * Registers the configuration tools.
 *
 * Its own module rather than more of `server.ts`, which is already the longest
 * file in the project. `tests/unit/mcp-destructive-tools.test.ts` scans every
 * module in `src/mcp/` for exactly this reason — a control that named one file
 * would have stopped covering the surface the moment the surface grew a second.
 */
export function registerConfigTools(server: McpServer, dependencies: ConfigToolDependencies): void {
  const { configuration, logger, principal, confirmations } = dependencies;
  const guard: ToolGuard = createToolGuard({ principal, logger });
  const guardDestructive = createDestructiveToolGuard({ principal, logger, confirmations }, guard);

  server.registerTool(
    'ferret_config_describe',
    {
      title: 'Read Ferret configuration',
      description:
        "Read Ferret's effective configuration and where each value came from. " +
        'Omit `path` for everything; pass a dotted path such as `database.host` ' +
        'for one value. Values are resolved through the precedence ladder — ' +
        'defaults, environment, user file, repository policy — so `origin` tells ' +
        'you which layer won, and writing a file will not help if the ' +
        'environment is supplying the value. Credentials read back as ' +
        '`[redacted]`.',
      inputSchema: z.strictObject({
        path: z.string().min(1).max(256).optional().describe('Dotted path, e.g. database.host.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path }) =>
      guard('config.describe', Permission.CONFIG_READ, () => {
        const { config, origins, sources } = configuration.resolve();

        if (path === undefined) {
          return Promise.resolve({
            // Redacted by EPIC-003's own describer, so there is no second
            // redaction policy here to drift from that one.
            configuration: describeConfig(config),
            origins,
            sources,
            file: configuration.store.path,
            fileExists: configuration.store.exists,
            unwritableThroughThisSurface: [...UNWRITABLE_ROOTS],
          });
        }

        const segments = parsePath(path);
        const leaf = segments.at(-1) ?? path;
        const secret = isSecretKey(leaf);
        const value = getAt(config, segments);

        return Promise.resolve({
          path,
          // Redacted here rather than after rendering: a caller must not be able
          // to extract a password one path at a time, which is the same reason
          // `ferret config get` redacts at this point.
          value: secret && value !== undefined ? '[redacted]' : (value ?? null),
          redacted: secret && value !== undefined,
          // An absent value is `null` with `set: false` beside it, so "unset" and
          // "set to null" are distinguishable — Governance §6.
          set: value !== undefined,
          origin: origins[path] ?? 'default',
        });
      }),
  );

  server.registerTool(
    'ferret_config_schema',
    {
      title: 'Discover what is configurable',
      description:
        'The JSON Schema of Ferret configuration: every key, its type, its ' +
        'default and its allowed values. Read this before writing configuration ' +
        'rather than guessing a key name. Generated from the schema Ferret ' +
        'actually validates against, so it cannot describe a configuration ' +
        'Ferret would reject.',
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      guard('config.schema', Permission.CONFIG_READ, () =>
        Promise.resolve({
          // `io: 'input'` describes what may be *written*, which is the question
          // an agent about to call `ferret_config_set` is asking. The output
          // schema would include values that only ever come from a default.
          schema: z.toJSONSchema(ferretConfigSchema, { io: 'input' }),
          // Stated in the same response as the schema, because an agent that
          // read the schema and not this would write `authorization` and be
          // refused for a reason the schema alone does not explain.
          unwritableThroughThisSurface: [...UNWRITABLE_ROOTS],
          secretPathsTakeAReference: '{"$secret":{"env":"VARIABLE_NAME"}}',
        }),
      ),
  );

  server.registerTool(
    'ferret_config_validate',
    {
      title: 'Check the configuration is usable',
      description:
        'Check that the effective configuration is valid and that Ferret has ' +
        'what it needs to run. Changes nothing. Use this after a write, or when ' +
        'a command is failing and you want to know whether configuration is why.',
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      guard('config.validate', Permission.CONFIG_READ, () => {
        // Resolution *is* validation: `resolveConfig` parses through the schema
        // and throws `E_CONFIG_INVALID` when it cannot. Catching it here rather
        // than letting it out turns "your configuration is broken" into an
        // answer, which is what a validate tool is for — the same reason
        // EPIC-004's `doctor` returns a report instead of failing.
        try {
          const { config, sources } = configuration.resolve();
          // EPIC-003's own list, in its own declaration order.
          const missing = missingDatabaseFields(config);
          return Promise.resolve({
            valid: true,
            usable: missing.length === 0,
            ...(missing.length === 0 ? {} : { missingDatabaseFields: missing }),
            sources,
          });
        } catch (error) {
          if (error instanceof FerretError && error.code === ErrorCode.CONFIG_INVALID) {
            return Promise.resolve({
              valid: false,
              usable: false,
              problem: error.message,
              remediation: error.remediation,
            });
          }
          throw error;
        }
      }),
  );

  server.registerTool(
    'ferret_config_audit',
    {
      title: 'What configuration changed, and when',
      description:
        "Read Ferret's configuration change journal, newest last. Records the " +
        'path, the action and who made it; never a credential and never a ' +
        'previous value. Use this to see what a previous session changed.',
      inputSchema: z.strictObject({
        limit: z.number().int().min(1).max(AUDIT_LIMIT).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit }) =>
      guard('config.audit', Permission.CONFIG_READ, () => {
        // The journal *this store* writes, not the platform default. Found by a
        // test against a temporary store: `readAudit()` with no argument read a
        // different file, so the tool reported an empty journal while the store
        // beside it had two entries — the one failure mode a journal must not
        // have, since "nothing changed" and "I looked in the wrong place" are
        // indistinguishable to the caller.
        //
        // Returns an empty array when the journal does not exist: nothing has
        // been changed yet is an answer, not a failure.
        const entries = readAudit(configuration.store.auditPath);
        const bounded = Math.min(limit ?? 20, AUDIT_LIMIT);
        return Promise.resolve({
          count: entries.length,
          returned: Math.min(entries.length, bounded),
          entries: entries.slice(-bounded),
        });
      }),
  );

  server.registerTool(
    'ferret_config_exclusions',
    {
      title: 'What Ferret will not index',
      description:
        'List the exclusion rules in force, or pass `path` to ask whether one ' +
        'particular path is excluded and by which rule. This is usually the ' +
        'answer when Ferret cannot find a file you know exists. An exclusion ' +
        'governs indexing and retrieval; it never deletes evidence already ' +
        'recorded.',
      inputSchema: z.strictObject({
        path: z.string().min(1).max(1024).optional().describe('A repository-relative path to test.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path }) =>
      guard('config.exclusions', Permission.CONFIG_READ, () => {
        const { config } = configuration.resolve();
        // Ferret's defaults *plus* the user's, which is what actually applies —
        // `config.exclude` alone would under-report and read as "nothing is
        // excluded" on a default installation.
        const rules = effectiveExclusions(config);

        if (path === undefined) {
          return Promise.resolve({
            count: rules.length,
            rules,
            note: 'An exclusion governs indexing and retrieval. It never deletes evidence already recorded.',
          });
        }

        const decision = evaluateExclusion(path, rules);
        return Promise.resolve({
          path,
          excluded: decision.excluded,
          // The rule that decided it, so "why is this excluded" is answerable
          // without the caller re-deriving it from the list.
          rule: decision.rule ?? null,
        });
      }),
  );

  server.registerTool(
    'ferret_config_set',
    {
      title: 'Change one configuration value',
      description:
        'Store one configuration value. Call it without `confirm` first: Ferret ' +
        'replies with exactly what would change and a token, and changes ' +
        'nothing. Call it again with that token to apply. Read ' +
        'ferret_config_schema first if you are unsure of a key. Credentials ' +
        'take a secret reference, never the value itself. ' +
        CONTENT_NOTICE,
      inputSchema: z.strictObject({
        path: z.string().min(1).max(256).describe('Dotted path, e.g. database.host.'),
        value: configValueSchema.describe('The JSON value to store.'),
        confirm: z.string().min(1).max(256).optional().describe(CONFIRM_PARAMETER_DESCRIPTION),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ path, value, confirm }) =>
      guardDestructive(
        'config.set',
        Permission.CONFIG_WRITE,
        () => {
          // `parsePath` runs **inside** the thunk, not above this call. Found by
          // a test: a malformed path thrown outside the guard never reaches
          // `serializeError`, so the client got an unredacted protocol error with
          // no `code` to branch on instead of a structured `E_USAGE`.
          //
          // Everything here therefore runs after the permission check and before
          // anything is disclosed or written.
          const segments = parsePath(path);
          assertWritablePath(segments);
          assertNotLiteralSecret(path, segments, value);
          return planForSet(configuration.store, path, segments, value);
        },
        confirm,
        () => {
          // EPIC-003's store: lock, re-read, validate, write atomically, journal.
          // An invalid value throws `E_CONFIG_INVALID` from inside here and the
          // file is left byte-identical.
          const result = configuration.store.set(path, value);
          // EPIC-091 AC-12, the line EPIC-066 §262 wrote as "loggable" and
          // never wrote. The path and the principal; never the value — that is
          // the whole point, and `redacted` records whether the value *would*
          // have been masked had anything printed it.
          logger.info(
            {
              // Not `mcp.config.set` — that is the tool name, and the guard
              // already logs the authorization decision under it. This record
              // says the file changed, which is a different event.
              operation: 'mcp.config.stored',
              principal: principal.id,
              path,
              file: result.path,
              redacted: isSecretKey(path.split('.').at(-1) ?? path),
            },
            `Configuration ${path} written`,
          );
          return Promise.resolve({
            path,
            stored: true,
            file: result.path,
            redacted: isSecretKey(path.split('.').at(-1) ?? path),
            journalled: result.auditError === undefined,
            // A configuration change reaches a *running* server's behaviour only
            // where that server re-reads. Said rather than implied: an agent that
            // changed an exclusion and saw no change in retrieval should know why.
            note: 'Stored. Restart the MCP server for a change to exclusions or scope to affect retrieval.',
          });
        },
      ),
  );

  server.registerTool(
    'ferret_config_unset',
    {
      title: 'Remove one configuration value',
      description:
        "Remove one stored configuration value, restoring Ferret's default. Call " +
        'it without `confirm` first to see what would be removed; call it again ' +
        'with the returned token to apply. A value supplied by the environment ' +
        'is not removed by this — check `origin` with ferret_config_describe. ' +
        CONTENT_NOTICE,
      inputSchema: z.strictObject({
        path: z.string().min(1).max(256).describe('Dotted path, e.g. database.host.'),
        confirm: z.string().min(1).max(256).optional().describe(CONFIRM_PARAMETER_DESCRIPTION),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ path, confirm }) =>
      guardDestructive(
        'config.unset',
        Permission.CONFIG_WRITE,
        () => {
          const segments = parsePath(path);
          assertWritablePath(segments);
          return planForUnset(configuration.store, path, segments);
        },
        confirm,
        () => {
          const result = configuration.store.unset(path);
          return Promise.resolve({
            path,
            removed: true,
            file: result.path,
            journalled: result.auditError === undefined,
          });
        },
      ),
  );
}
