import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Builds `dist/` once before the suite runs.
 *
 * Integration tests exercise the published artefact by spawning it as a real
 * process, so they need a build that matches the sources under test. Doing it
 * here rather than in each file keeps the build to one invocation.
 */
export default function setup(): void {
  execFileSync(process.execPath, ['node_modules/typescript/lib/tsc.js', '-p', 'tsconfig.build.json'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
}
