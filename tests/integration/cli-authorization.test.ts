import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ExitCode } from '../../src/cli/exit-codes.js';
import { CONFIG_FILE_VERSION } from '../../src/config/index.js';
import { createNullLogger } from '../../src/index.js';
import { migrate } from '../../src/storage/index.js';
import { ROOT, runCli } from '../helpers/cli.js';
import {
  SKIP_REASON,
  createTestDatabase,
  databaseAvailable,
  type TestDatabase,
} from '../support/postgres.js';

/**
 * The CLI is authorized like every other entry point — EPIC-083 AC-3, AC-4.
 *
 * Driven through the installed binary as a real child process rather than by
 * calling the action function, because the property under test is that a *user
 * running `ferret index`* is refused. EPIC-058's own lesson, recorded at
 * `validation/EPIC-058-VALIDATION.md`: "a criterion satisfied one layer below
 * where it matters is a criterion with a gap above it."
 *
 * Needs a real database: the permission check is the first statement inside the
 * runtime, and the runtime does not start without storage. Refusing before that
 * would mean refusing before configuration has been resolved, which is where the
 * grant comes from.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;

let db: TestDatabase;
let workspace: string;

/** Writes a configuration file granting exactly these permissions. */
function configGranting(permissions: readonly string[]): string {
  const path = join(workspace, `granting-${permissions.join('-') || 'nothing'}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      version: CONFIG_FILE_VERSION,
      authorization: { principalId: 'ferret.test-operator', permissions },
    }),
    'utf8',
  );
  return path;
}

/** A configuration granting these permissions *and* configuring a tracker. */
function configSyncing(permissions: readonly string[]): string {
  const path = join(workspace, `syncing-${permissions.join('-') || 'nothing'}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      version: CONFIG_FILE_VERSION,
      authorization: { principalId: 'ferret.test-operator', permissions },
      providers: {
        // Unroutable on purpose: this file is about the permission check, which
        // happens before anything is fetched.
        'ferret.source.github': { enabled: true, options: { baseUrl: 'http://127.0.0.1:1' } },
      },
    }),
    'utf8',
  );
  return path;
}

describeDb(`CLI authorization (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    db = await createTestDatabase('cli-authorization');
    // The CLI runs its storage provider under `MigrationPolicy.VERIFY`, so an
    // unmigrated database is refused at exit 6 before authorization is ever
    // consulted — which would have made every assertion below vacuous.
    await migrate(db.pool, { logger: createNullLogger() });
    workspace = mkdtempSync(join(tmpdir(), 'ferret-cli-auth-'));
  });

  afterAll(async () => {
    await db.drop();
  });

  it('refuses to index when configuration withholds the permission — AC-3', async () => {
    const result = await runCli(['index', ROOT, '--no-history', '--no-files', '--no-changes'], {
      env: { ...db.env, FERRET_CONFIG: configGranting(['read']) },
    });

    expect(result.code).toBe(ExitCode.NOT_PERMITTED);
    expect(result.stderr).toContain('E_NOT_PERMITTED');
  });

  it('names the permission in the refusal and nothing about the repository — AC-9', async () => {
    const result = await runCli(['index', ROOT, '--no-history', '--no-files', '--no-changes'], {
      env: { ...db.env, FERRET_CONFIG: configGranting(['read']) },
    });

    // Non-vacuous first: this must be the refusal, not some earlier failure.
    expect(result.code).toBe(ExitCode.NOT_PERMITTED);
    expect(result.stderr).toContain('E_NOT_PERMITTED');
    expect(result.stderr).toContain('index');
    expect(result.stderr).not.toContain(ROOT);
    // And it does not leak the grant surface it read.
    expect(result.stderr).not.toContain(db.password);
  });

  it('indexes when configuration grants it — AC-3, the control', async () => {
    // Without this the refusal above could be any failure that happens to exit 7.
    const result = await runCli(['index', ROOT, '--no-history', '--no-files', '--no-changes'], {
      env: { ...db.env, FERRET_CONFIG: configGranting(['read', 'index']) },
    });

    expect(result.stderr).not.toContain('E_NOT_PERMITTED');
    expect(result.code).toBe(ExitCode.OK);
  });

  it('refuses to export when configuration withholds read — EPIC-089 AC-6', async () => {
    // An export is the largest read Ferret performs: every row it holds, in one
    // file. So it is checked as a read, and a grant that withholds `read`
    // withholds it — which is the point of checking a bulk read at all.
    const result = await runCli(['export'], {
      env: { ...db.env, FERRET_CONFIG: configGranting(['index']) },
    });

    expect(result.code).toBe(ExitCode.NOT_PERMITTED);
    expect(result.stderr).toContain('E_NOT_PERMITTED');
    expect(result.stderr).toContain('export');
  });

  it('exports when configuration grants read — EPIC-089 AC-6, the control', async () => {
    const result = await runCli(['export'], {
      env: { ...db.env, FERRET_CONFIG: configGranting(['read']) },
    });

    expect(result.stderr).not.toContain('E_NOT_PERMITTED');
    expect(result.code).toBe(ExitCode.OK);
  });

  it('refuses to import when configuration withholds index — EPIC-090 AC-13', async () => {
    // An import writes rows, so it is an index. The document is read and
    // verified first, which is why the fixture has to be a valid one: a
    // refusal on the document would prove nothing about the permission.
    const document = join(workspace, 'empty-export.ndjson');
    const exported = await runCli(['export', '--out', document], {
      env: { ...db.env, FERRET_CONFIG: configGranting(['read']) },
    });
    expect(exported.code).toBe(ExitCode.OK);

    const result = await runCli(['import', document, '--yes'], {
      env: { ...db.env, FERRET_CONFIG: configGranting(['read']) },
    });

    expect(result.code).toBe(ExitCode.NOT_PERMITTED);
    expect(result.stderr).toContain('E_NOT_PERMITTED');
    expect(result.stderr).toContain('import');
  });

  it('imports when configuration grants index — EPIC-090 AC-13, the control', async () => {
    const document = join(workspace, 'granted-export.ndjson');
    await runCli(['export', '--out', document], {
      env: { ...db.env, FERRET_CONFIG: configGranting(['read']) },
    });

    const result = await runCli(['import', document, '--yes'], {
      env: { ...db.env, FERRET_CONFIG: configGranting(['read', 'index']) },
    });

    expect(result.stderr).not.toContain('E_NOT_PERMITTED');
    expect(result.code).toBe(ExitCode.OK);
  });

  it('refuses to reconcile when configuration withholds index — EPIC-078 AC-6', async () => {
    // A pass indexes, so it is checked as an index — the same grant `index`
    // needs, because an unattended pass must not be a way around one.
    const result = await runCli(['reconcile'], {
      env: { ...db.env, FERRET_CONFIG: configGranting(['read']) },
    });

    expect(result.code).toBe(ExitCode.NOT_PERMITTED);
    expect(result.stderr).toContain('E_NOT_PERMITTED');
    expect(result.stderr).toContain('reconcile');
  });

  it('reconciles when configuration grants index — EPIC-078, the control', async () => {
    const result = await runCli(['reconcile', '--dry-run'], {
      env: { ...db.env, FERRET_CONFIG: configGranting(['read', 'index']) },
    });

    expect(result.stderr).not.toContain('E_NOT_PERMITTED');
    expect(result.code).toBe(ExitCode.OK);
  });

  it('refuses to sync when configuration withholds index — EPIC-113 AC-16', async () => {
    // A sync ingests, so it is checked as an index. The provider is configured
    // in this file too: composing the tracker happens before the runtime
    // starts, so without it the pass would fail for want of configuration and
    // the denial under test would never be reached.
    const result = await runCli(['sync', 'o/r'], {
      env: { ...db.env, FERRET_CONFIG: configSyncing(['read']) },
    });

    expect(result.code).toBe(ExitCode.NOT_PERMITTED);
    expect(result.stderr).toContain('E_NOT_PERMITTED');
    expect(result.stderr).toContain('sync');
  });

  it('syncs when configuration grants index — EPIC-113, the control', async () => {
    // `--dry-run` still reads the tracker, and the address is unroutable, so
    // the pass fails per project and reports it rather than being denied. The
    // claim under test is the absence of a refusal, not a successful fetch.
    const result = await runCli(['sync', 'o/r', '--dry-run'], {
      env: { ...db.env, FERRET_CONFIG: configSyncing(['read', 'index']) },
    });

    expect(result.stderr).not.toContain('E_NOT_PERMITTED');
  });

  it('refuses to record a session when configuration withholds record — EPIC-117 AC-7', async () => {
    // `index` is deliberately not enough. That is the whole of D-117.3: an
    // operator who granted ingestion did not thereby grant an agent the ability
    // to write into Ferret's record of its own reasoning.
    const result = await runCli(['session', 'start'], {
      env: { ...db.env, FERRET_CONFIG: configGranting(['read', 'index']) },
    });

    expect(result.code).toBe(ExitCode.NOT_PERMITTED);
    expect(result.stderr).toContain('E_NOT_PERMITTED');
    expect(result.stderr).toContain('record');
  });

  it('records a session when configuration grants record — EPIC-117, the control', async () => {
    const result = await runCli(['session', 'start', '--json'], {
      env: { ...db.env, FERRET_CONFIG: configGranting(['read', 'record']) },
    });

    expect(result.stderr).not.toContain('E_NOT_PERMITTED');
    expect(result.code).toBe(ExitCode.OK);
  });

  it('records a session with no authorization configured at all — the default', async () => {
    // `LOCAL_OPERATOR_PRINCIPAL` gains `record` with EPIC-117, so splitting the
    // permission out of `index` took nothing away from an operator at their own
    // machine. Asserted, because that is the half of the amendment that is easy
    // to get wrong and impossible to notice.
    const result = await runCli(['session', 'start', '--json'], { env: db.env });

    expect(result.stderr).not.toContain('E_NOT_PERMITTED');
    expect(result.code).toBe(ExitCode.OK);
  });

  it('refuses to apply an upgrade when configuration withholds index — EPIC-106 AC-11', async () => {
    // The plan is a read; applying changes the schema, so it takes the grant
    // `index` needs. A read-only grant must not be a way to migrate.
    const result = await runCli(['upgrade', '--yes'], {
      env: { ...db.env, FERRET_CONFIG: configGranting(['read']) },
    });

    expect(result.code).toBe(ExitCode.NOT_PERMITTED);
    expect(result.stderr).toContain('E_NOT_PERMITTED');
    expect(result.stderr).toContain('upgrade');
  });

  it('plans an upgrade with only read — EPIC-106, the control', async () => {
    const result = await runCli(['upgrade'], {
      env: { ...db.env, FERRET_CONFIG: configGranting(['read']) },
    });

    expect(result.stderr).not.toContain('E_NOT_PERMITTED');
    expect(result.code).toBe(ExitCode.OK);
  });

  it('indexes with no authorization configured at all — AC-3, the default', async () => {
    // EPIC-083 §16. The CLI's unconfigured default is the local operator, not the
    // anonymous client: refusing a person at their own machine protects nobody,
    // and a Ferret that could not index until someone wrote a configuration file
    // would be a worse product rather than a safer one.
    const result = await runCli(['index', ROOT, '--no-history', '--no-files', '--no-changes'], {
      env: db.env,
    });

    expect(result.stderr).not.toContain('E_NOT_PERMITTED');
    expect(result.code).toBe(ExitCode.OK);
  });
});
