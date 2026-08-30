import { describe, expect, it } from 'vitest';

import {
  ConfigPrecedence,
  DEFAULT_EXCLUSIONS,
  ExclusionScope,
  REPOSITORY_ALLOWED_KEYS,
  describeSecretRef,
  effectiveExclusions,
  environmentSource,
  evaluateExclusion,
  filterRepositoryFragment,
  isExcluded,
  isSecretRef,
  mergeExclusions,
  normalizePath,
  parseConfig,
  parseConfigFile,
  resolveConfig,
  resolveSecretRef,
  resolveSecrets,
  sessionSource,
  explicitSource,
  type ConfigSource,
} from '../../src/index.js';

/** A source built from a literal fragment, for exercising precedence. */
function source(name: string, precedence: number, fragment: Record<string, unknown>): ConfigSource {
  return { name, precedence, read: () => fragment };
}

describe('precedence', () => {
  it('follows the Governance §16 ladder, so a stored setting beats an environment variable', () => {
    const { config, origins } = resolveConfig([
      environmentSource({ FERRET_DATABASE_HOST: 'from-env', FERRET_LOG_LEVEL: 'error' }),
      source('file', ConfigPrecedence.USER, { database: { host: 'from-file' } }),
    ]);

    expect(config.database.host).toBe('from-file');
    // The environment still supplies anything the file does not.
    expect(config.logLevel).toBe('error');
    expect(origins['database.host']).toBe('file');
    expect(origins['logLevel']).toBe('environment');
  });

  it('applies layers in precedence order regardless of the order they are passed', () => {
    const layers = [
      source('explicit', ConfigPrecedence.EXPLICIT, { logLevel: 'trace' }),
      source('defaults-ish', ConfigPrecedence.DEFAULTS, { logLevel: 'silent' }),
      source('session', ConfigPrecedence.SESSION, { logLevel: 'debug' }),
    ];

    for (const permutation of [layers, [...layers].reverse(), [layers[1]!, layers[2]!, layers[0]!]]) {
      expect(resolveConfig(permutation).config.logLevel).toBe('trace');
    }
  });

  it('is deterministic — the same layers always produce the same result', () => {
    const layers = [
      environmentSource({ FERRET_DATABASE_PORT: '6000' }),
      source('file', ConfigPrecedence.USER, { database: { host: 'db' }, exclude: ['tmp'] }),
      source('session', ConfigPrecedence.SESSION, { logLevel: 'info' }),
    ];
    const first = resolveConfig(layers);
    const second = resolveConfig(layers);
    expect(JSON.stringify(second.config)).toBe(JSON.stringify(first.config));
    expect(second.origins).toStrictEqual(first.origins);
  });

  it('merges nested objects rather than replacing them wholesale', () => {
    const { config } = resolveConfig([
      source('a', ConfigPrecedence.ENVIRONMENT, { database: { host: 'h', user: 'u' } }),
      source('b', ConfigPrecedence.USER, { database: { user: 'override' } }),
    ]);
    expect(config.database.host).toBe('h');
    expect(config.database.user).toBe('override');
  });

  it('records the source of every value, so configuration can explain itself', () => {
    const { origins } = resolveConfig([
      environmentSource({ FERRET_DATABASE_HOST: 'h' }),
      source('session', ConfigPrecedence.SESSION, { database: { port: 6000 }, logLevel: 'warn' }),
    ]);
    expect(origins).toStrictEqual({
      'database.host': 'environment',
      'database.port': 'session',
      logLevel: 'session',
    });
  });

  it('starts with no configuration at all', () => {
    const { config } = resolveConfig([]);
    expect(config.logLevel).toBe('warn');
    expect(config.database.port).toBe(5432);
    expect(config.exclude).toStrictEqual([]);
    expect(config.providers).toStrictEqual({});
  });
});

describe('mutable scopes', () => {
  it('lets a session change its layer without touching disk, and clear it again', () => {
    const session = sessionSource({ logLevel: 'info' });
    const layers = [environmentSource({}), session];

    expect(resolveConfig(layers).config.logLevel).toBe('info');
    session.merge({ logLevel: 'debug' });
    expect(resolveConfig(layers).config.logLevel).toBe('debug');
    session.clear();
    expect(resolveConfig(layers).config.logLevel).toBe('warn');
    expect(session.isEmpty).toBe(true);
  });

  it('copies on read, so a caller cannot mutate the layer through its own result', () => {
    const session = sessionSource({ database: { host: 'a' } });
    const fragment = session.read();
    (fragment as { database: { host: string } }).database.host = 'tampered';
    expect((session.read() as { database: { host: string } }).database.host).toBe('a');
  });

  it('puts an explicit operation above everything stored', () => {
    const explicit = explicitSource({ logLevel: 'trace' });
    const { config } = resolveConfig([
      environmentSource({ FERRET_LOG_LEVEL: 'error' }),
      source('file', ConfigPrecedence.USER, { logLevel: 'info' }),
      sessionSource({ logLevel: 'debug' }),
      explicit,
    ]);
    expect(config.logLevel).toBe('trace');
  });
});

describe('secret references', () => {
  it('recognizes only a well-formed reference', () => {
    expect(isSecretRef({ $secret: { env: 'X' } })).toBe(true);
    expect(isSecretRef({ $secret: { file: '/x' } })).toBe(true);
    // Ambiguous or incomplete shapes are not references; treating them as one
    // would silently discard whichever source was ignored.
    expect(isSecretRef({ $secret: { env: 'X', file: '/x' } })).toBe(false);
    expect(isSecretRef({ $secret: {} })).toBe(false);
    expect(isSecretRef({ $secret: { env: '' } })).toBe(false);
    expect(isSecretRef('env:X')).toBe(false);
    expect(isSecretRef(null)).toBe(false);
  });

  it('resolves from the environment', () => {
    const value = resolveSecretRef({ $secret: { env: 'MY_SECRET' } }, { MY_SECRET: 'hunter2' });
    expect(value).toBe('hunter2');
  });

  it('resolves from a file, ignoring the trailing newline a shell adds', () => {
    const value = resolveSecretRef({ $secret: { file: '/run/secret' } }, {}, () => 'hunter2\n');
    expect(value).toBe('hunter2');
  });

  it('fails loudly when the source is missing, naming the source and never a value', () => {
    let thrown: unknown;
    try {
      resolveSecretRef({ $secret: { env: 'ABSENT' } }, {});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'E_CONFIG_INVALID' });
    expect((thrown as { message: string }).message).toContain('ABSENT');
    expect((thrown as { remediation: string }).remediation).toContain('ABSENT');
  });

  it('fails when a secret file is empty rather than using an empty password', () => {
    expect(() => resolveSecretRef({ $secret: { file: '/run/secret' } }, {}, () => '\n')).toThrow(
      /empty value/,
    );
  });

  it('replaces references anywhere in a fragment', () => {
    const resolved = resolveSecrets(
      { database: { password: { $secret: { env: 'PW' } } }, providers: { a: { options: { token: { $secret: { env: 'TK' } } } } } },
      { env: { PW: 'p', TK: 't' } },
    ) as { database: { password: string }; providers: { a: { options: { token: string } } } };

    expect(resolved.database.password).toBe('p');
    expect(resolved.providers.a.options.token).toBe('t');
  });

  it('can describe a reference without reading it, for introspection', () => {
    const described = resolveSecrets(
      { database: { password: { $secret: { env: 'PW' } } } },
      { resolve: false },
    ) as { database: { password: string } };
    expect(described.database.password).toBe('[from environment variable PW]');
    expect(describeSecretRef({ $secret: { file: '/run/s' } })).toBe('file /run/s');
  });

  it('resolves references during configuration resolution, before validation', () => {
    const { config } = resolveConfig(
      [source('file', ConfigPrecedence.USER, { database: { password: { $secret: { env: 'PW' } } } })],
      { env: { PW: 'hunter2' } },
    );
    expect(config.database.password).toBe('hunter2');
  });

  it('treats a reference as a leaf, not as an object to merge into', () => {
    const { config } = resolveConfig(
      [
        source('a', ConfigPrecedence.ENVIRONMENT, { database: { password: 'literal' } }),
        source('b', ConfigPrecedence.USER, { database: { password: { $secret: { env: 'PW' } } } }),
      ],
      { env: { PW: 'from-ref' } },
    );
    expect(config.database.password).toBe('from-ref');
  });
});

describe('repository policy is a trust boundary', () => {
  it('accepts only exclusions', () => {
    expect([...REPOSITORY_ALLOWED_KEYS]).toStrictEqual(['exclude']);
  });

  it('refuses everything a hostile repository could use to reconfigure Ferret', () => {
    // A `.ferret/config.json` is shared with everyone who clones the repository.
    // Cloning must never repoint someone's database or enable a provider.
    const { accepted, ignored } = filterRepositoryFragment({
      exclude: ['secrets/**'],
      database: { host: 'attacker.example', password: 'x' },
      logLevel: 'trace',
      providers: { 'evil.provider': { enabled: true } },
    });

    expect(accepted).toStrictEqual({ exclude: ['secrets/**'] });
    expect(ignored.sort()).toStrictEqual(['database', 'logLevel', 'providers']);
  });

  it('reports what it refused, so a repository author is not left guessing', () => {
    const { ignored } = filterRepositoryFragment({ database: {} });
    expect(ignored).toStrictEqual(['database']);
  });
});

describe('exclusions', () => {
  const rules = [
    { pattern: 'node_modules', scope: ExclusionScope.GLOBAL },
    { pattern: 'docs/**/*.pdf', scope: ExclusionScope.REPOSITORY, reason: 'large binaries' },
  ];

  it('treats a bare directory name as that directory and everything under it', () => {
    expect(isExcluded('node_modules', rules)).toBe(true);
    expect(isExcluded('node_modules/pkg/index.js', rules)).toBe(true);
    expect(isExcluded('src/node_modules/x.js', rules)).toBe(true);
    expect(isExcluded('src/index.js', rules)).toBe(false);
  });

  it('matches globs, and reports which rule decided', () => {
    const decision = evaluateExclusion('docs/2024/report.pdf', rules);
    expect(decision.excluded).toBe(true);
    expect(decision.rule?.reason).toBe('large binaries');
    expect(evaluateExclusion('docs/2024/report.md', rules).excluded).toBe(false);
  });

  it('normalizes Windows separators so one rule set works on both platforms', () => {
    expect(normalizePath('docs\\a\\b.pdf')).toBe('docs/a/b.pdf');
    expect(isExcluded('docs\\2024\\report.pdf', rules)).toBe(true);
  });

  it('respects effectiveFrom, so a question about the past gets the past answer', () => {
    const dated = [
      { pattern: 'archive', scope: ExclusionScope.GLOBAL, effectiveFrom: '2026-06-01T00:00:00Z' },
    ];
    expect(isExcluded('archive/old.md', dated, { at: new Date('2026-01-01T00:00:00Z') })).toBe(false);
    expect(isExcluded('archive/old.md', dated, { at: new Date('2026-12-01T00:00:00Z') })).toBe(true);
  });

  it('never mutates the rules it is given — evaluation is a decision, not an action', () => {
    const before = JSON.stringify(rules);
    evaluateExclusion('node_modules/x', rules);
    evaluateExclusion('anything/else', rules);
    expect(JSON.stringify(rules)).toBe(before);
  });

  it('merges additively across scopes and collapses duplicates', () => {
    const merged = mergeExclusions(
      [{ pattern: 'a', scope: ExclusionScope.GLOBAL }],
      [{ pattern: 'a', scope: ExclusionScope.GLOBAL }, { pattern: 'b', scope: ExclusionScope.REPOSITORY }],
    );
    expect(merged.map((rule) => rule.pattern)).toStrictEqual(['a', 'b']);
  });

  it('keeps Ferret\'s defaults ahead of user rules, so they cannot be displaced', () => {
    const config = parseConfig({ exclude: ['my-stuff'] });
    const effective = effectiveExclusions(config);

    expect(effective.slice(0, DEFAULT_EXCLUSIONS.length).map((rule) => rule.pattern)).toStrictEqual(
      DEFAULT_EXCLUSIONS.map((rule) => rule.pattern),
    );
    expect(effective.at(-1)?.pattern).toBe('my-stuff');
    expect(isExcluded('.git/objects/ab/cdef', effective)).toBe(true);
  });

  it('accepts the shorthand and the full rule form alike', () => {
    const config = parseConfig({
      exclude: ['simple', { pattern: 'detailed/**', scope: 'session', reason: 'why' }],
    });
    expect(config.exclude[0]).toStrictEqual({ pattern: 'simple', scope: 'global' });
    expect(config.exclude[1]).toMatchObject({ pattern: 'detailed/**', scope: 'session', reason: 'why' });
  });

  it('keeps the user\'s stated intent separate from what Ferret applies', () => {
    const config = parseConfig({ exclude: ['mine'] });
    expect(config.exclude).toHaveLength(1);
    expect(effectiveExclusions(config).length).toBe(DEFAULT_EXCLUSIONS.length + 1);
  });
});

describe('configuration file parsing', () => {
  it('accepts a bare object, so a hand-written file need not know about versioning', () => {
    const file = parseConfigFile('{"logLevel":"debug"}', '/x/config.json');
    expect(file.version).toBe(1);
    expect(file.config).toStrictEqual({ logLevel: 'debug' });
  });

  it('accepts the versioned envelope', () => {
    const file = parseConfigFile('{"version":1,"config":{"logLevel":"debug"}}', '/x/config.json');
    expect(file).toStrictEqual({ version: 1, config: { logLevel: 'debug' } });
  });

  it('refuses a file from a newer Ferret rather than misreading it', () => {
    let thrown: unknown;
    try {
      parseConfigFile('{"version":99,"config":{}}', '/x/config.json');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'E_CONFIG_INVALID' });
    expect((thrown as { remediation: string }).remediation).toContain('Upgrade Ferret');
  });

  it('names the file when the JSON is malformed, and says deleting it is safe', () => {
    let thrown: unknown;
    try {
      parseConfigFile('{ not json', '/x/config.json');
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { message: string }).message).toContain('/x/config.json');
    expect((thrown as { remediation: string }).remediation).toContain('always safe');
  });

  it('rejects a document that is not an object', () => {
    expect(() => parseConfigFile('[]', '/x/config.json')).toThrow(/JSON object/);
    expect(() => parseConfigFile('"text"', '/x/config.json')).toThrow(/JSON object/);
  });
});

describe('provider configuration', () => {
  it('validates the shape while leaving option meaning to the provider', () => {
    const config = parseConfig({
      providers: { 'ferret.storage.postgres': { enabled: false, options: { anything: 1 } } },
    });
    expect(config.providers['ferret.storage.postgres']).toStrictEqual({
      enabled: false,
      options: { anything: 1 },
    });
  });

  it('defaults a provider to enabled with no options', () => {
    const config = parseConfig({ providers: { 'a.b': {} } });
    expect(config.providers['a.b']).toStrictEqual({ enabled: true, options: {} });
  });

  it('rejects an id that is not a provider identifier', () => {
    let thrown: unknown;
    try {
      parseConfig({ providers: { 'Not A Provider': {} } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'E_CONFIG_INVALID' });
    expect((thrown as { details: { issues: { path: string }[] } }).details.issues[0]?.path).toContain(
      'providers',
    );
  });

  it('rejects a malformed provider entry, naming the path', () => {
    let thrown: unknown;
    try {
      parseConfig({ providers: { 'a.b': { enabled: 'yes' } } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'E_CONFIG_INVALID' });
    expect((thrown as { details: { issues: { path: string }[] } }).details.issues[0]?.path).toContain(
      'providers.a.b.enabled',
    );
  });
});
