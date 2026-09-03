import { registerCredentialValue } from '../security/credentials.js';

import type { FerretConfig } from './schema.js';

/**
 * Which configuration fields are credentials, and who is allowed to see one —
 * EPIC-081 §8.1.
 *
 * Ferret's disclosure controls were already strong when this was written:
 * `describeConfig` redacts at the render boundary, `redact.ts` redacts by key,
 * value shape and URI userinfo, the audit journal records that a secret changed
 * and never to what. What did not exist was any *possession* control. Every
 * provider — a parser, an MCP server, a Git source — received one
 * `ProviderHostContext` carrying the resolved configuration, and therefore
 * received the database password it has no use for.
 *
 * **Absent, not redacted.** A placeholder is a string, and a string in a
 * password field is something a caller eventually hands to `pg`. Removing the
 * field means the mistake is a type error rather than an afternoon.
 */

/** Dotted paths whose values are credentials. */
export const CREDENTIAL_CONFIG_PATHS: readonly string[] = Object.freeze(['database.password']);

/**
 * The configuration a provider sees: everything, minus every credential.
 *
 * A structural `Omit` rather than a runtime convention, so
 * `context.config.database.password` does not compile. That is the assertion
 * EPIC-081 §10 asks for, and it is worth more than a test: it holds for
 * provider code that has not been written yet.
 */
export type ProviderVisibleConfig = Omit<FerretConfig, 'database'> & {
  readonly database: Omit<FerretConfig['database'], 'password'>;
};

/**
 * The configuration with every credential field removed.
 *
 * A shallow rebuild rather than a deep clone: the credential paths Ferret has
 * are two levels deep, and a clone would copy the whole document per provider
 * to solve a problem it does not have. If a credential is ever nested deeper
 * than this, {@link CREDENTIAL_CONFIG_PATHS} and this function change together
 * and the test enumerating them fails first.
 */
export function withoutCredentialFields(config: FerretConfig): ProviderVisibleConfig {
  const { password: _password, ...database } = config.database;
  return { ...config, database };
}

/**
 * The credentials one provider declared, and nothing else.
 *
 * Keyed by the same dotted path the provider declared, so the provider names
 * what it needs and reads back exactly that. A declared path with no value
 * configured is simply absent — this reports what Ferret holds, and inventing
 * an empty string here would recreate the empty-password failure
 * `secret-ref.ts` has refused to produce since it was written.
 */
export function credentialsFor(
  config: FerretConfig,
  declared: readonly string[],
): Readonly<Record<string, string>> {
  const granted: Record<string, string> = {};
  for (const path of declared) {
    if (!CREDENTIAL_CONFIG_PATHS.includes(path)) continue;
    if (path === 'database.password' && config.database.password !== undefined) {
      granted[path] = config.database.password;
      // F-71. A password written literally in `config.json` never passes
      // through secret resolution, so this is the one place Ferret learns it is
      // holding one. Registering it here is what keeps it out of a subprocess
      // environment under a name nothing lists, and out of a log line.
      registerCredentialValue(config.database.password);
    }
  }
  return granted;
}
