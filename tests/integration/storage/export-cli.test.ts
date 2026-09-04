import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readAuditEvents } from '../../../src/index.js';
// From the storage subpath, not the core: `export.ts` sits beside Drizzle, and
// `boundaries.test.ts` asserts the core entry point reaches no storage module.
import { readExportDocument } from '../../../src/storage/index.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';
import { runCli } from '../../helpers/cli.js';

/**
 * `ferret export` end to end — EPIC-089 AC-1, AC-6, AC-9, AC-12, AC-13, AC-14.
 *
 * Through the CLI because the properties that matter here are the CLI's: the
 * document reaching a file intact, the audit event EPIC-085 §4 said reads would
 * *not* produce, and the refusal to wrap `pg_dump`.
 */

const describeCli = databaseAvailable() ? describe : describe.skip;

let db: TestDatabase;
let home: string;
let env: NodeJS.ProcessEnv;

interface Envelope {
  readonly ok: boolean;
  readonly data: Record<string, unknown>;
}

function journalPath(): string {
  return join(home, 'audit-events.ndjson');
}

describeCli(`ferret export (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    db = await createTestDatabase('exportcli');
    home = mkdtempSync(join(tmpdir(), 'ferret-export-home-'));
    env = { ...db.env, FERRET_CONFIG: join(home, 'config.json') };
    writeFileSync(join(home, 'config.json'), '{}\n', 'utf8');

    const initialised = await runCli(['init', '--json'], { env });
    expect(initialised.code, initialised.stderr).toBe(0);
  }, 120_000);

  afterAll(async () => {
    rmSync(home, { recursive: true, force: true });
    await db.drop();
  });

  it('writes a document with a manifest first and a trailer last — AC-1', async () => {
    const out = join(home, 'index.ndjson');

    const result = await runCli(['export', '--out', out, '--json'], { env });
    expect(result.code, result.stderr).toBe(0);

    const document = readExportDocument(readFileSync(out, 'utf8'));
    expect(document.manifest?.kind).toBe('ferret-export');
    expect(document.trailer?.kind).toBe('ferret-export-trailer');
    // And the digest the reader recomputes matches the one written — AC-10 end
    // to end, through a real file rather than a string in memory.
    expect(document.digest).toBe(document.trailer?.digest);
  });

  it('writes the document to stdout when no destination is given', async () => {
    const result = await runCli(['export'], { env });
    expect(result.code, result.stderr).toBe(0);

    const document = readExportDocument(result.stdout);
    expect(document.manifest).toBeDefined();
    expect(document.trailer).toBeDefined();
  });

  it('exports an empty index as a valid document — AC-11', async () => {
    // `init` provisions the schema and indexes nothing, so this *is* the empty
    // case: two lines and no rows.
    const result = await runCli(['export'], { env });
    const document = readExportDocument(result.stdout);

    expect(document.trailer?.rows).toBe(0);
    expect(document.rows).toStrictEqual([]);
  });

  it('records one audit event naming the row count — AC-12', async () => {
    // EPIC-085 §4 recorded that reads are *not* audited, by design. A bulk read
    // of everything Ferret knows is the deliberate exception, so this asserts
    // the exception is actually taken.
    await runCli(['export', '--out', join(home, 'audited.ndjson')], { env });

    const events = readAuditEvents(journalPath()).filter((one) => one.action === 'export');
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.outcome).toBe('permitted');
    expect(events[0]?.reason).toMatch(/^\d+ row\(s\)$/);
  });

  it('names the pg_dump command and the configuration file, and needs no database — AC-14', async () => {
    // No `db.env`: an operator asking what the backup command is should not
    // need a reachable database to be told.
    const result = await runCli(['export', '--backup-command', '--json'], {
      env: { FERRET_CONFIG: join(home, 'config.json') },
    });
    expect(result.code, result.stderr).toBe(0);

    const body = (JSON.parse(result.stdout) as Envelope).data;
    expect(String(body['backupCommand'])).toContain('pg_dump');
    expect(String(body['backupCommand'])).toContain('--schema=ferret');
    expect(String(body['configurationFile'])).toContain('config.json');
  });

  it('keeps the configuration secret as a reference, so no exporter is needed — AC-9', async () => {
    // Through `config set` rather than a hand-written file: the claim is about
    // what the product *stores*, and a fixture would be asserting my own JSON.
    //
    // Its own configuration path, because a `database.password` in the file
    // outranks the test database URL.
    //
    // The variable is set, because `config set` **resolves** a reference before
    // storing it and refuses one it cannot — EPIC-081 working correctly, and it
    // strengthens §8.4: an unresolvable reference can never reach the file, so
    // a copied configuration always points somewhere that existed.
    const isolated = join(home, 'secret-config.json');
    const stored = await runCli(
      ['config', 'set', 'database.password', '{"$secret":{"env":"FERRET_PG_PASSWORD"}}', '--json'],
      { env: { FERRET_CONFIG: isolated, FERRET_PG_PASSWORD: 'resolved-at-set-time' } },
    );
    expect(stored.code, stored.stderr).toBe(0);

    // The file carries its own `version` envelope around the settings, which
    // is the other half of §8.4: it is already a *versioned* portable document,
    // so a copy is readable by a build that is not this one.
    const onDisk = JSON.parse(readFileSync(isolated, 'utf8')) as {
      version?: number;
      config?: { database?: { password?: unknown } };
    };
    expect(onDisk.version).toBe(1);
    const password = onDisk.config?.database?.password;

    // Where the secret is, never what it is — which is what makes copying the
    // file a complete configuration backup, §8.4. The value that resolution
    // just produced is *not* written down.
    expect(password).toStrictEqual({ $secret: { env: 'FERRET_PG_PASSWORD' } });
    expect(readFileSync(isolated, 'utf8')).not.toContain('resolved-at-set-time');
  });

  it('offers no command that wraps pg_dump or pg_restore — AC-15', async () => {
    const help = await runCli(['--help'], { env });

    expect(help.stdout).toContain('export');
    expect(help.stdout).not.toContain('restore');
    expect(help.stdout).not.toContain('backup ');
  });

  it('exports no secret-shaped value out of an index that holds none — §8.4', async () => {
    const out = join(home, 'faithful.ndjson');
    await runCli(['export', '--out', out], { env });

    const raw = readFileSync(out, 'utf8');
    // **What this measures, stated accurately.** It measures §8.4's *first*
    // line of defence — that the index holds no credential, because every
    // producer redacts before it writes (EPIC-087 §8.2). It does not and
    // cannot measure a second line at export time, because this fixture's
    // index has nothing for one to catch.
    //
    // The title used to cite AC-6 and AC-13, which are the `READ` grant and the
    // audit event, and the comment used to claim this asserted that an
    // export-time redactor "has not been removed". Neither was true, and the
    // second became actively misleading when D1 stopped that redactor
    // rewriting values: a faithful export of an index that *did* hold a
    // credential now carries it, reports it in the trailer, and offers
    // `--strict` to refuse instead. That behaviour is measured where it can
    // be — `export-fidelity.test.ts`, against an index seeded with one.
    expect(raw).not.toContain('password=');
    expect(raw).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
    // And the positive half, which is the claim that is actually available
    // here: the scanner ran and found nothing, rather than not having run.
    const trailer = readExportDocument(raw).trailer;
    expect(trailer?.credentialShaped).toStrictEqual([]);
  });
});
