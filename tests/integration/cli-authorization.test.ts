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
