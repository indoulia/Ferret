import { performance } from 'node:perf_hooks';

import { Metric, defaultMetrics } from '../../observability/index.js';
import { Command, Option } from 'commander';

import { Permission, assertPermitted, localOperatorFrom } from '../../authorization/index.js';
import { registerCodeSymbolKind } from '../../code/index.js';
import { registerDurableContextKind } from '../../context/index.js';
import { IntegrityFindingKind, type IntegrityFinding } from '../../domain/index.js';
import { createGitSourceProvider } from '../../git/index.js';
import { RepositoryIndexer, contentProducerIdentity } from '../../indexing/index.js';
import type { LogLevel } from '../../logging/index.js';
import { ParserFramework } from '../../parsing/index.js';
import { Capability, assertSupported, discoverProviders } from '../../providers/index.js';
import { createRuntime } from '../../runtime/index.js';
import {
  CompatibilityService,
  EntityStore,
  EvidenceStore,
  IndexLifecycleStore,
  ContentStore,
  IndexRunStore,
  IntegrityService,
  MigrationPolicy,
  RelationshipStore,
  SymbolStore,
  createStorageProvider,
  type SweepReport,
} from '../../storage/index.js';
import { VERSION } from '../../version.js';
import { emitResult, type OutputOptions } from '../output.js';
import { FERRET_PARSERS_MODULE, loadFerretParsers } from './parser-composition.js';

/**
 * `ferret verify` — EPIC-094 §3.6.
 *
 * Governance §13 asks that a corrupt or stale index be *detectable and
 * recoverable without requiring the user to become a database administrator*.
 * Before this, neither half was reachable: the one integrity check Ferret had
 * (`EvidenceStore.verify`) had no production caller, entities and relationships
 * had no check at all, and the only remediation anyone was offered was prose
 * saying the next `ferret index` would probably sort it out.
 *
 * **Two verbs, never fused.** `verify` reads and reports; `--repair` re-reads
 * from source. A sweep that repaired as it went would make its own report
 * unreproducible, and an operator who cannot see the finding before the fix
 * cannot tell a real problem from a bug in the checker.
 *
 * **Repair is re-derivation.** No path here issues an `UPDATE` against a hash or
 * an observation. The only correct fix for a row that disagrees with its hash is
 * a fresh reading of the source superseding it; editing the row to match the
 * hash launders a corruption into a fact, which Governance §6 treats as worse
 * than an absence.
 */
export function verifyCommand(
  output: (json: boolean) => OutputOptions,
  reportExitCode: (code: number) => void,
): Command {
  return new Command('verify')
    .description('Check that what Ferret stored is still what Ferret derived, and optionally repair it')
    .addOption(new Option('--repair', 'Re-read affected repositories from source').default(false))
    .addOption(new Option('--scope <repositoryId>', 'Restrict the sweep to one repository entity'))
    .addOption(
      new Option('--limit <n>', 'Rows to examine per table before stopping and saying so').argParser(Number),
    )
    .addOption(
      new Option('--yes', 'Proceed with a repair without being asked to confirm').default(false),
    )
    .addOption(
      new Option(
        '--content',
        'Re-read file content during a repair, for an index that was built with it',
      ).default(false),
    )
    .action(
      async (
        options: { repair: boolean; scope?: string; limit?: number; yes: boolean; content: boolean },
        command: Command,
      ) => {
        const globals = command.optsWithGlobals<{ json?: boolean; logLevel?: LogLevel }>();
        const json = globals.json === true;

        const storage = createStorageProvider({ policy: MigrationPolicy.VERIFY });
        const source = createGitSourceProvider();
        const runtime = createRuntime({
          providers: [storage, source],
          ...(globals.logLevel === undefined ? {} : { logLevel: globals.logLevel }),
        });

        // Before the runtime starts: `ProviderRegistry` refuses a registration
        // once initialized, so a parser composed inside `runtime.run` never
        // registers and the content stage silently reads nothing. The same
        // ordering `ferret index` depends on, and the same reason.
        // `options.content` alone, not `repair && content`. Detection needs the
        // parser as much as repair does: EPIC-094 AC-7 asks that a
        // `content-index` artefact built by a superseded parser be *reported*,
        // and only a composed parser can say what this build would stamp on one.
        // Without it those rows stay `unassessable`, which is honest and is
        // what a run without `--content` still gets.
        const discovery = options.content
          ? await discoverProviders(runtime.providers, [FERRET_PARSERS_MODULE], loadFerretParsers)
          : undefined;

        const result = await runtime.run(async (context) => {
          // Reading the index is a read; repairing it re-runs the indexer, so a
          // repair is an index. Both are checked, and the repair check happens
          // before anything is read rather than before anything is written —
          // there is no reason to sweep for a caller who may not act on it.
          // Spelled out at each call rather than hoisted into a local:
          // `tests/unit/authorization-enforcement.test.ts` asserts this exact
          // shape across every command, and a local would satisfy the intent
          // while failing the check that keeps the intent true.
          assertPermitted(localOperatorFrom(context.config), Permission.READ, 'verify');
          if (options.repair) {
            assertPermitted(localOperatorFrom(context.config), Permission.INDEX, 'verify.repair');
          }

          assertSupported(runtime.providers.supports(Capability.STORAGE));

          // Without this every `code_symbol` row reads as `schema-invalid`:
          // `createEntity` refuses a kind the *current process* has not
          // registered, and 1 811 of them were reported as corrupt on Ferret's
          // own index for no reason but composition. Registering the kind is a
          // pure domain call — no grammar, no parser, nothing from
          // `parsers/` — so the CLI's boundary is untouched, and it is
          // idempotent by design.
          registerCodeSymbolKind();
          // EPIC-126, and the same defect one kind later: durable context is
          // registered too, or every `context` row reads as `schema-invalid`.
          // Found by dogfooding — 4 of 4 on Ferret's own index.
          registerDurableContextKind();

          const integrity = new IntegrityService(storage.db);
          // AC-7 — present only when a parser was composed, so the sweep either
          // judges a content artefact or reports it unassessable, and never
          // guesses. The resolver lives in `indexing/` because that is where the
          // producer it speaks for lives; `src/storage/` may not import a parser
          // at all, which `boundaries.test.ts` asserts.
          const producerIdentity =
            discovery === undefined
              ? undefined
              : contentProducerIdentity(new ParserFramework({ registry: runtime.providers }));
          const sweepOptions = {
            ...(options.scope === undefined ? {} : { repositoryId: options.scope }),
            ...(producerIdentity === undefined ? {} : { producerIdentity }),
            logger: context.logger,
          };
          // EPIC-092 §8.6. EPIC-094 §16 asked for repair timing by name, and a
          // sweep that takes minutes on a large index is exactly the thing an
          // operator wants a number for.
          const sweepStartedAt = performance.now();
          const sweep = await integrity.sweep({
            ...sweepOptions,
            ...(options.limit === undefined || Number.isNaN(options.limit) ? {} : { limit: options.limit }),
          });

          defaultMetrics().observe(Metric.VERIFY_MS, performance.now() - sweepStartedAt);

          if (!options.repair) return { sweep, repaired: [] as string[], confirmed: true };

          // A finding that names no scope still has to be repairable.
          //
          // `source.scope` is a *parent*, and the kinds most worth repairing —
          // `commit`, `repository` — have none: a commit belongs to a
          // repository through a relationship, not through its identity. So a
          // scopeless finding widens the repair to every repository rather than
          // being silently unfixable, which is the honest reading of "Ferret
          // does not know which repository this row came from".
          //
          // Heavy-handed, and deliberately so: a repair is explicit, confirmed,
          // and idempotent, so re-reading a repository that turns out to be
          // fine costs a read and writes nothing.
          const named = repairableScopes(sweep.findings);
          const scopes =
            named.length === sweep.findings.length ? named : [...new Set([...named, ...(await allRepositories(storage.pool))])];
          if (scopes.length === 0) return { sweep, repaired: [] as string[], confirmed: true };

          // AC-15. A repair re-reads a repository and supersedes what it finds,
          // which is a change to what Ferret believes. The CLI has no
          // interactive channel it can rely on — Governance §3 has Ferret
          // spawned by an AI client — so the confirmation is an explicit flag
          // rather than a prompt that would hang in a pipe.
          if (!options.yes) {
            return { sweep, repaired: [] as string[], confirmed: false, wouldRepair: scopes };
          }

          assertSupported(runtime.providers.supports(Capability.SOURCE_REPOSITORY));
          const entities = new EntityStore(storage.db);
          const compatibility = new CompatibilityService(storage.db, storage.pool);

          // EPIC-094 §3.4 — `markStale` finally has a caller.
          // EPIC-010's validation recorded the gap plainly: "Nothing rebuilds a
          // stale derived artefact. The marking exists, the rebuild does not."
          // It is called here rather than in the sweep because the sweep is
          // read-only by contract: detection reads, repair writes, and marking
          // is a write.
          const marked = await Promise.all(
            staleProducers(sweep.findings).map(async (producer) => compatibility.markStale(producer, VERSION)),
          );
          const markedCount = marked.reduce((total, n) => total + n, 0);
          if (markedCount > 0) {
            context.logger.info(
              { operation: 'index.integrity.stale', marked: markedCount },
              `Marked ${String(markedCount)} derived artefact(s) stale before re-deriving them`,
            );
          }
          const operation = { logger: context.logger, signal: context.signal };
          const indexer = new RepositoryIndexer({
            source,
            entities,
            relationships: new RelationshipStore(storage.db),
            evidence: new EvidenceStore(storage.db),
            watermarks: compatibility,
            lifecycle: new IndexLifecycleStore(storage.db),
            runs: new IndexRunStore(storage.db),
            ...(options.content && discovery !== undefined
              ? {
                  content: source,
                  symbols: new SymbolStore(storage.db),
                  parser: new ParserFramework({ registry: runtime.providers }),
                  artifacts: compatibility,
                  blobs: new ContentStore(storage.db),
                }
              : {}),
            logger: context.logger,
          });

          const repaired: string[] = [];
          for (const scopeId of scopes) {
            const repositoryEntity = await entities.get(scopeId);
            // A scope Ferret cannot resolve to a repository it can still read is
            // reported, not guessed at. Repairing a corrupt *source* is EPIC-093's
            // problem and explicitly not this Epic's.
            if (repositoryEntity === undefined || repositoryEntity.kind !== 'repository') continue;
            const root = repositoryEntity.unknownFields['localRoot'];
            if (typeof root !== 'string' || root.length === 0) continue;

            const described = await source.describeRepository(root, operation);
            // `full: true` — a repair exists because Ferret's model of this
            // repository is wrong, and an incremental run would resume from a
            // watermark written by the run that produced the wrong model.
            // `--content` is off by default and must be, but an index built
            // *with* content and repaired without it loses the structure the
            // content stage put on its `file` entities — EPIC-108 §18.5 records
            // the same contention between the history and structure stages.
            // Ferret cannot guess which kind of index this was, so the operator
            // says, and the human output below says so when they did not.
            await indexer.index(
              described,
              {
                full: true,
                withHistory: true,
                withFiles: true,
                withContent: options.content,
                // AC-11's effect half — issue #101. A repair exists because a
                // stored row is wrong, so it must not take that row's own hash
                // as evidence that it is right.
                rederive: true,
              },
              operation,
            );
            repaired.push(scopeId);
          }

          // AC-16 — detection re-run, so the report says whether the repair
          // worked rather than that it was attempted.
          // The same options as the sweep above, resolver included: a
          // re-detection that judged fewer rows than the first pass would report
          // a repair as successful because it stopped looking.
          const after = await integrity.sweep(sweepOptions);
          return {
            sweep: after,
            repaired,
            confirmed: true,
            before: sweep.findings.length,
            withContent: options.content,
          };
        });

        emitResult(output(json), result, () => render(result));
        // A finding is not a crash and not a usage error. Exit 1 so a script can
        // branch on "the index is not clean" without parsing text, and 0 when it
        // is — the same contract `--strict` gives `ferret status`.
        reportExitCode(result.sweep.findings.length === 0 ? 0 : 1);
      },
    );
}

/**
 * The repository scopes a re-read would actually fix.
 *
 * A stale artefact or an unfinished run is repaired by re-indexing its scope; an
 * altered row is repaired by re-reading the repository that produced it. A
 * finding with no scope names nothing to re-read and is reported without a
 * repair, rather than triggering a full re-index of the installation on the
 * strength of one bad row.
 */
/** Every repository entity, for a finding that names no scope of its own. */
async function allRepositories(pool: { query: (text: string) => Promise<{ rows: { id: string }[] }> }): Promise<string[]> {
  const { rows } = await pool.query(`SELECT id FROM ferret.entity WHERE kind = 'repository'`);
  return rows.map((row) => row.id);
}

function staleProducers(findings: readonly IntegrityFinding[]): string[] {
  const producers = new Set<string>();
  for (const finding of findings) {
    if (finding.kind !== IntegrityFindingKind.STALE_ARTIFACT) continue;
    // The producer is named in the detail, which is the one place it is
    // recorded on a finding. Parsed rather than added as a field, because a
    // finding's shape is what a caller reads and a producer id is an internal
    // name — see the note on `detail` in `domain/integrity.ts`.
    const producer = /Built by ([^@]+)@/.exec(finding.detail)?.[1];
    if (producer !== undefined) producers.add(producer);
  }
  return [...producers];
}

function repairableScopes(findings: readonly IntegrityFinding[]): string[] {
  const scopes = new Set<string>();
  for (const finding of findings) {
    if (finding.kind === IntegrityFindingKind.UNFINISHED_RUN && finding.scope === undefined) continue;
    if (finding.scope !== undefined) scopes.add(finding.scope);
  }
  return [...scopes];
}

interface VerifyResult {
  readonly sweep: SweepReport;
  readonly repaired: readonly string[];
  readonly withContent?: boolean;
  readonly confirmed: boolean;
  readonly wouldRepair?: readonly string[];
  readonly before?: number;
}

function render(result: VerifyResult): string {
  const { sweep } = result;
  const lines = [
    `examined          ${String(sweep.examined.entities)} of ${String(sweep.total.entities)} entities, ${String(sweep.examined.relationships)} of ${String(sweep.total.relationships)} relationships, ${String(sweep.examined.evidence)} of ${String(sweep.total.evidence)} observations`,
    `artefacts         ${String(sweep.examined.artifacts)} derived, ${String(sweep.examined.runs)} unfinished run(s)`,
  ];

  // The bound, stated. A partial sweep that reported nothing would look exactly
  // like a clean installation, which is the failure this Epic exists to end.
  lines.push(
    sweep.complete
      ? 'coverage          complete'
      : `coverage          PARTIAL — stopped at the bound in: ${sweep.truncated.join(', ')}. Re-run to continue.`,
  );

  if (sweep.findings.length === 0) {
    lines.push('', sweep.complete ? 'No problems found.' : 'No problems found in what was examined.');
  } else {
    lines.push('');
    for (const finding of sweep.findings) {
      lines.push(`${finding.kind}  ${finding.subject} ${finding.id}`);
      lines.push(`  ${finding.detail}`);
      lines.push(`  → ${finding.remediation}`);
    }
    lines.push('', `${String(sweep.findings.length)} finding(s).`);
  }

  if (result.wouldRepair !== undefined) {
    lines.push(
      '',
      `${String(result.wouldRepair.length)} repository scope(s) would be re-read from source, superseding what is wrong.`,
      'Nothing has been changed. Re-run with --yes to proceed.',
    );
  }
  if (result.repaired.length > 0) {
    lines.push('', `Repaired ${String(result.repaired.length)} scope(s) by re-reading them from source.`);
    if (!result.withContent) {
      lines.push(
        'Content was not re-read. If this index was built with `ferret index --content`,',
        're-run this repair with --content so file structure and symbols come back.',
      );
    }
    if (result.before !== undefined) {
      lines.push(`Findings before repair: ${String(result.before)}; after: ${String(sweep.findings.length)}.`);
    }
  }

  return lines.join('\n');
}
