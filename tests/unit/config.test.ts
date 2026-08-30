import { describe, expect, it } from 'vitest';

import {
  ConfigPrecedence,
  DEFAULT_DATABASE_PORT,
  FerretError,
  REDACTED,
  describeConfig,
  environmentSource,
  isDatabaseConfigured,
  missingDatabaseFields,
  parseConfig,
  resolveConfig,
  type ConfigSource,
} from '../../src/index.js';

const fixedSource = (name: string, precedence: number, value: Record<string, unknown>): ConfigSource => ({
  name,
  precedence,
  read: () => value,
});

describe('resolveConfig — no configuration supplied', () => {
  it('succeeds with an empty environment, so nothing must be authored to start Ferret', () => {
    const { config } = resolveConfig([environmentSource({})]);
    expect(config.logLevel).toBe('warn');
    expect(config.database.port).toBe(DEFAULT_DATABASE_PORT);
    expect(config.database.host).toBeUndefined();
    expect(config.exclude).toStrictEqual([]);
  });

  it('reports which database fields are still missing', () => {
    const { config } = resolveConfig([environmentSource({})]);
    expect(isDatabaseConfigured(config)).toBe(false);
    expect(missingDatabaseFields(config)).toStrictEqual(['host', 'database', 'user', 'password']);
  });
});

describe('resolveConfig — environment source', () => {
  it('reads the documented bootstrap surface', () => {
    const { config, sources } = resolveConfig([
      environmentSource({
        FERRET_LOG_LEVEL: 'debug',
        FERRET_DATABASE_HOST: 'db.internal',
        FERRET_DATABASE_PORT: '6543',
        FERRET_DATABASE_NAME: 'ferretdb',
        FERRET_DATABASE_USER: 'ferret',
        FERRET_DATABASE_PASSWORD: 'hunter2',
        FERRET_EXCLUDE: 'node_modules, dist ;coverage',
      }),
    ]);

    expect(config.logLevel).toBe('debug');
    expect(config.database).toStrictEqual({
      host: 'db.internal',
      port: 6543,
      database: 'ferretdb',
      user: 'ferret',
      password: 'hunter2',
      migrate: 'auto',
    });
    // EPIC-003 turned the shorthand into full rules, so an exclusion can carry
    // a scope, a reason and an effective-from instant. The shorthand still
    // works — Governance §2 caps ordinary setup at database details plus these.
    expect(config.exclude).toStrictEqual([
      { pattern: 'node_modules', scope: 'global' },
      { pattern: 'dist', scope: 'global' },
      { pattern: 'coverage', scope: 'global' },
    ]);
    expect(isDatabaseConfigured(config)).toBe(true);
    expect(sources).toStrictEqual(['environment']);
  });

  it('ignores unset and empty variables', () => {
    const { config } = resolveConfig([environmentSource({ FERRET_DATABASE_HOST: '' })]);
    expect(config.database.host).toBeUndefined();
  });

  it('coerces a numeric port from its string form', () => {
    const { config } = resolveConfig([environmentSource({ FERRET_DATABASE_PORT: '5433' })]);
    expect(config.database.port).toBe(5433);
  });
});

describe('resolveConfig — precedence', () => {
  it('applies sources in ascending precedence order regardless of input order', () => {
    const { config, sources } = resolveConfig([
      fixedSource('session', ConfigPrecedence.SESSION, { database: { host: 'session-host' } }),
      fixedSource('defaults', ConfigPrecedence.DEFAULTS, {
        database: { host: 'default-host', database: 'from-defaults' },
      }),
    ]);

    expect(config.database.host).toBe('session-host');
    expect(config.database.database).toBe('from-defaults');
    expect(sources).toStrictEqual(['defaults', 'session']);
  });

  it('merges nested objects rather than replacing them wholesale', () => {
    const { config } = resolveConfig([
      fixedSource('a', 0, { database: { host: 'h', user: 'u' } }),
      fixedSource('b', 100, { database: { user: 'override' } }),
    ]);
    expect(config.database.host).toBe('h');
    expect(config.database.user).toBe('override');
  });

  it('replaces arrays instead of concatenating them', () => {
    const { config } = resolveConfig([
      fixedSource('a', 0, { exclude: ['one', 'two'] }),
      fixedSource('b', 100, { exclude: ['three'] }),
    ]);
    expect(config.exclude).toStrictEqual([{ pattern: 'three', scope: 'global' }]);
  });
});

describe('resolveConfig — invalid configuration', () => {
  it('rejects an out-of-range port with an actionable error', () => {
    let thrown: unknown;
    try {
      resolveConfig([environmentSource({ FERRET_DATABASE_PORT: '99999' })]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(FerretError);
    const error = thrown as FerretError;
    expect(error.code).toBe('E_CONFIG_INVALID');
    expect(error.message).toContain('database.port');
    expect(error.remediation).toBeDefined();
  });

  it('rejects a non-numeric port', () => {
    expect(() => resolveConfig([environmentSource({ FERRET_DATABASE_PORT: 'not-a-port' })])).toThrow(
      /database\.port/,
    );
  });

  it('rejects an unknown log level', () => {
    expect(() => resolveConfig([environmentSource({ FERRET_LOG_LEVEL: 'chatty' })])).toThrow(/logLevel/);
  });

  it('never echoes the rejected value, which may itself be a credential', () => {
    let thrown: FerretError | undefined;
    try {
      parseConfig({ database: { port: 'sup3r-s3cret-value' } });
    } catch (error) {
      thrown = error as FerretError;
    }
    const serialized = JSON.stringify(thrown?.toJSON());
    expect(serialized).not.toContain('sup3r-s3cret-value');
    expect(serialized).toContain('database.port');
  });
});

describe('describeConfig', () => {
  it('redacts the password and keeps every diagnosable field', () => {
    const config = parseConfig({
      database: { host: 'db', port: 5432, database: 'ferretdb', user: 'ferret', password: 'hunter2' },
    });
    const described = describeConfig(config);

    expect(JSON.stringify(described)).not.toContain('hunter2');
    expect(described).toStrictEqual({
      logLevel: 'warn',
      database: {
        host: 'db',
        port: 5432,
        database: 'ferretdb',
        user: 'ferret',
        password: REDACTED,
        migrate: 'auto',
      },
      exclude: [],
      providers: {},
    });
  });

  it('omits undefined fields rather than rendering them', () => {
    const described = describeConfig(parseConfig({})) as { database: Record<string, unknown> };
    expect('host' in described.database).toBe(false);
  });
});
