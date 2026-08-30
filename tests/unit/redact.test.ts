import { describe, expect, it } from 'vitest';

import { REDACTED, isSecretKey, redact, redactString } from '../../src/index.js';

describe('isSecretKey', () => {
  it.each([
    'password',
    'passwd',
    'pwd',
    'secret',
    'token',
    'apiKey',
    'api_key',
    'API-KEY',
    'accessToken',
    'refresh_token',
    'privateKey',
    'authorization',
    'credentials',
    'connectionString',
    'databasePassword',
    'cookie',
    'passphrase',
    'key',
  ])('treats %s as secret', (key) => {
    expect(isSecretKey(key)).toBe(true);
  });

  it.each(['host', 'port', 'database', 'user', 'logLevel', 'keyword', 'keywords', 'name', 'version'])(
    'treats %s as safe',
    (key) => {
      expect(isSecretKey(key)).toBe(false);
    },
  );
});

describe('redactString', () => {
  it('masks the password in a database URI but keeps the diagnosable parts', () => {
    const result = redactString('postgres://ferret:hunter2@db.internal:5432/ferretdb');
    expect(result).toBe(`postgres://ferret:${REDACTED}@db.internal:5432/ferretdb`);
    expect(result).not.toContain('hunter2');
  });

  it('leaves a URI without credentials untouched', () => {
    const uri = 'https://github.com/indoulia/Ferret.git';
    expect(redactString(uri)).toBe(uri);
  });

  it('masks password fields inside a connection string', () => {
    const result = redactString('Host=db;Database=ferret;User Id=ferret;Password=hunter2;');
    expect(result).not.toContain('hunter2');
    expect(result).toContain('Host=db');
  });

  it.each([
    ['github token', 'ghp_0123456789abcdefghijklmnopqrstuvwx'],
    ['github fine-grained token', 'github_pat_11ABCDEFG0abcdefghijklmnop'],
    ['aws access key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['openai-style key', 'sk-abcdefghijklmnopqrstuvwxyz0123'],
    [
      'jwt',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    ],
  ])('masks a bare %s regardless of key name', (_label, secret) => {
    const result = redactString(`value is ${secret} here`);
    expect(result).not.toContain(secret);
    expect(result).toContain(REDACTED);
  });

  it('masks a PEM private key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----';
    expect(redactString(`key: ${pem}`)).not.toContain('MIIEow==');
  });
});

describe('redactString — prefixed secret names', () => {
  // The shape secrets actually take in the environment Ferret runs in. The
  // original pattern anchored on `(password)`, which does not match after an
  // underscore, so it missed every one of these. Found by an EPIC-008 evidence
  // test that expected a masked value and got the real one.
  it.each([
    'DATABASE_PASSWORD=hunter2',
    'FERRET_DATABASE_PASSWORD=hunter2',
    'PG_PASSWORD=hunter2',
    'GITHUB_TOKEN=hunter2',
    'MY_API_KEY=hunter2',
    'app_secret=hunter2',
  ])('masks %s', (input) => {
    const output = redactString(input);
    expect(output).not.toContain('hunter2');
    expect(output).toContain(REDACTED);
    // The name survives, so a log still says *which* setting was involved.
    expect(output.split('=')[0]).toBe(input.split('=')[0]);
  });

  it('still masks the unprefixed form', () => {
    expect(redactString('password=hunter2')).not.toContain('hunter2');
  });

  it('leaves an innocent assignment alone', () => {
    // The alternation must be followed immediately by `=`, so a name that
    // merely contains "token" is not treated as one.
    expect(redactString('MY_TOKENIZER=lexer')).toBe('MY_TOKENIZER=lexer');
    expect(redactString('keyword=search')).toBe('keyword=search');
    expect(redactString('PASSWORD_POLICY_URL=https://example')).toContain('PASSWORD_POLICY_URL');
  });
});

describe('redact', () => {
  it('redacts secret-named properties at every depth', () => {
    const result = redact({
      database: { host: 'db', password: 'hunter2', nested: { apiKey: 'abc' } },
      safe: 'value',
    }) as Record<string, Record<string, unknown>>;

    expect(result.database?.password).toBe(REDACTED);
    expect((result.database?.nested as Record<string, unknown>).apiKey).toBe(REDACTED);
    expect(result.database?.host).toBe('db');
    expect(result.safe).toBe('value');
  });

  it('redacts inside arrays', () => {
    const result = redact([{ token: 'abc' }, { host: 'db' }]) as Array<Record<string, unknown>>;
    expect(result[0]?.token).toBe(REDACTED);
    expect(result[1]?.host).toBe('db');
  });

  it('breaks cycles instead of overflowing the stack', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node.self = node;
    expect(redact(node)).toStrictEqual({ name: 'root', self: '[circular]' });
  });

  it('truncates beyond the depth cap', () => {
    let deep: Record<string, unknown> = { value: 'leaf' };
    for (let i = 0; i < 20; i += 1) deep = { child: deep };
    expect(JSON.stringify(redact(deep))).toContain('[truncated]');
  });

  it('reduces class instances to a type marker rather than walking internals', () => {
    class Connection {
      readonly password = 'hunter2';
    }
    expect(redact(new Connection())).toBe('[Connection]');
    expect(JSON.stringify(redact({ conn: new Connection() }))).not.toContain('hunter2');
  });

  it('summarises errors without leaking embedded credentials', () => {
    const result = redact(new Error('connect postgres://u:p@h/db failed')) as Record<string, string>;
    expect(result.message).not.toContain(':p@');
    expect(result.name).toBe('Error');
  });

  it('passes primitives through unchanged', () => {
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
  });
});
