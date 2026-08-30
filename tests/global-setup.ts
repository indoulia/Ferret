import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { TestProject } from 'vitest/node';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The PostgreSQL image integration tests run against.
 *
 * Pinned to the image EPIC-005 benchmarked and validated pgvector 0.8.6 on, so
 * a migration suite that passes here passes against a server Ferret has
 * measured, not merely against "some PostgreSQL".
 */
const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';

const CONTAINER_USER = 'ferret_test';
const CONTAINER_PASSWORD = 'ferret_test_password';
const CONTAINER_DATABASE = 'ferret_test';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Base connection URL for integration tests, or `null` when none exists. */
    ferretTestDatabaseUrl: string | null;
  }
}

/**
 * Builds `dist/` and provisions the database integration tests share.
 *
 * Integration tests exercise the published artefact by spawning it as a real
 * process, so they need a build that matches the sources under test. Doing it
 * here rather than in each file keeps the build to one invocation.
 *
 * PostgreSQL comes from `FERRET_TEST_DATABASE_URL` when set — which is how CI
 * supplies a service container — and otherwise from a Docker container started
 * once for the whole run. When Docker is unavailable the database suites skip
 * with the reason stated in their titles rather than silently passing.
 */
export default async function setup({ provide }: TestProject): Promise<() => Promise<void>> {
  execFileSync(process.execPath, ['node_modules/typescript/lib/tsc.js', '-p', 'tsconfig.build.json'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  execFileSync(process.execPath, ['scripts/copy-migrations.mjs'], { cwd: ROOT, stdio: 'inherit' });

  const external = process.env['FERRET_TEST_DATABASE_URL'];
  if (external !== undefined && external !== '') {
    provide('ferretTestDatabaseUrl', external);
    return () => Promise.resolve();
  }

  // The cross-platform CI job sets this: it proves Ferret builds and its
  // non-database behaviour holds on Windows and Linux, and leaves database
  // coverage to the dedicated job with a pinned service container. Without the
  // opt-out that job would start a redundant container on Linux and silently
  // skip on Windows, which reads as coverage it does not have.
  if (process.env['FERRET_SKIP_DOCKER_POSTGRES'] === '1') {
    provide('ferretTestDatabaseUrl', null);
    return () => Promise.resolve();
  }

  try {
    const { GenericContainer, Wait } = await import('testcontainers');
    const container = await new GenericContainer(POSTGRES_IMAGE)
      .withExposedPorts(5432)
      .withEnvironment({
        POSTGRES_USER: CONTAINER_USER,
        POSTGRES_PASSWORD: CONTAINER_PASSWORD,
        POSTGRES_DB: CONTAINER_DATABASE,
      })
      // The entrypoint starts PostgreSQL once for initdb and again for real, so
      // the readiness line appears twice. Waiting for the first would hand tests
      // a server that is about to be shut down.
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .withStartupTimeout(120_000)
      .start();

    const url = `postgres://${CONTAINER_USER}:${CONTAINER_PASSWORD}@${container.getHost()}:${String(container.getMappedPort(5432))}/${CONTAINER_DATABASE}`;
    provide('ferretTestDatabaseUrl', url);
    // Child processes spawned by CLI integration tests inherit this.
    process.env['FERRET_TEST_DATABASE_URL'] = url;

    return async () => {
      await container.stop();
    };
  } catch (error) {
    // Not a failure: a contributor without Docker still gets the unit suite and
    // every non-database integration test. The database suites report why they
    // did not run.
    process.stderr.write(
      `\n[ferret] PostgreSQL integration tests will be skipped: ${(error as Error).message}\n\n`,
    );
    provide('ferretTestDatabaseUrl', null);
    return () => Promise.resolve();
  }
}
