import { describe, expect, it } from 'vitest';

import {
  ANONYMOUS_PRINCIPAL,
  LOCAL_OPERATOR_PRINCIPAL,
  PERMISSIONS,
  Permission,
  PrincipalClass,
  accessContextFor,
  assertPermitted,
  authorize,
  isPermission,
  localOperatorFrom,
  principalFrom,
  type Principal,
} from '../../src/authorization/index.js';
import { ErrorCode } from '../../src/errors/index.js';
import { ScopeKind } from '../../src/domain/index.js';
import { ferretConfigSchema } from '../../src/config/index.js';

/**
 * Who is asking, and what they may do — EPIC-068.
 *
 * EPIC-059/065's validation stated the position it corrects without softening
 * it: "**No authorization: every indexed thing is reachable by any client that
 * can spawn the process.** stdio limits the blast radius to whoever can already
 * run commands as that user, but it is not an authorization model."
 *
 * Three properties carry the Epic, and all three are about refusing:
 *
 * - **Deny by default**, including for a permission invented after the grant was
 *   written — the only safe direction for that change.
 * - **A denial names the permission, never the protected thing.** "You may not
 *   configure" is a fact about the caller; anything more is a fact about the data.
 * - **A refusal is an error, not an empty result** — the opposite of EPIC-058's
 *   rule, because an unpermitted operation did not happen and reporting success
 *   for it would be a lie.
 *
 * Nothing here needs a database or a clock, which is the point: an authorization
 * decision that cannot be reproduced cannot be reviewed.
 */

function granted(...permissions: readonly Permission[]): Principal {
  return {
    id: 'test.principal',
    class: PrincipalClass.AI_CLIENT,
    permissions,
    permittedScopes: [],
    scope: { include: [], exclude: [] },
  };
}

describe('the permission vocabulary', () => {
  it('recognises exactly what it defines', () => {
    for (const permission of PERMISSIONS) expect(isPermission(permission)).toBe(true);
    for (const other of ['', 'READ', 'read.all', 'admin', null, 7]) {
      expect(isPermission(other), String(other)).toBe(false);
    }
  });

  it('stays coarse', () => {
    // One permission per tool would be a vocabulary nobody configures correctly,
    // and Governance §2 makes simplicity a product requirement. This asserts the
    // decision rather than the number: a vocabulary that grew past a handful has
    // stopped being at the granularity a decision is made.
    expect(PERMISSIONS.length).toBeLessThanOrEqual(8);
  });
});

describe('deciding whether a caller may act', () => {
  it('allows what was granted', () => {
    expect(authorize(granted(Permission.READ), Permission.READ).allowed).toBe(true);
  });

  it('denies what was not — AC-2', () => {
    const reader = granted(Permission.READ);
    for (const permission of PERMISSIONS.filter((p) => p !== Permission.READ)) {
      expect(authorize(reader, permission).allowed, permission).toBe(false);
    }
  });

  it('denies a permission granted to nobody, however new — AC-2', () => {
    // The consequence that makes deny-by-default worth having: a permission added
    // to the vocabulary later is refused for every existing principal until it is
    // granted. Asserted against an empty grant, which is what a principal
    // configured before that permission existed looks like.
    const nothing = granted();
    for (const permission of PERMISSIONS) {
      expect(authorize(nothing, permission).allowed, permission).toBe(false);
    }
  });

  it('is pure: the same inputs decide the same way — AC-4', () => {
    const reader = granted(Permission.READ);
    const first = authorize(reader, Permission.MUTATE);
    const second = authorize(reader, Permission.MUTATE);
    expect(first).toStrictEqual(second);
  });

  it('names the permission and nothing about the protected thing — AC-5', () => {
    const decision = authorize(granted(Permission.READ), Permission.CONFIG_WRITE);

    expect(decision.reason).toContain(Permission.CONFIG_WRITE);
    expect(decision.reason).toContain('test.principal');
    // The assertion that matters, written as a shape check so a reason that
    // later interpolated a target fails here: a denial that leaks what it
    // protected is worse than the access it refused.
    expect(decision.reason).not.toMatch(/\//);
    expect(decision.reason).not.toMatch(/scope|path|password|secret|token/i);
  });
});

describe('the default principal', () => {
  it('may read and may do nothing else — AC-3', () => {
    // Everything Ferret indexes today is unscoped local source the caller could
    // read with `cat`, and Governance §3 makes the AI client the primary
    // interface — so denying reads out of the box would cost every user
    // something and protect nobody. Every other permission is denied, which is
    // why EPIC-066 and EPIC-067 cannot exist by accident.
    expect(authorize(ANONYMOUS_PRINCIPAL, Permission.READ).allowed).toBe(true);
    for (const permission of PERMISSIONS.filter((p) => p !== Permission.READ)) {
      expect(authorize(ANONYMOUS_PRINCIPAL, permission).allowed, permission).toBe(false);
    }
  });

  it('holds no permission scope, so scoped content stays hidden', () => {
    expect(ANONYMOUS_PRINCIPAL.permittedScopes).toStrictEqual([]);
    expect(accessContextFor(ANONYMOUS_PRINCIPAL).permittedScopes).toStrictEqual([]);
  });
});

describe('the principal a locally invoked command runs under — EPIC-083 AC-3, AC-4', () => {
  const unconfigured = ferretConfigSchema.parse({});

  it('may index, because refusing the operator at their own machine protects nobody', () => {
    // The anonymous default is right for a client that arrived over a transport
    // and wrong for the CLI: enforcing `INDEX` against `READ`-only would have
    // stopped `ferret index` working out of the box. Same argument EPIC-068 used
    // to grant the anonymous principal `READ`.
    expect(authorize(localOperatorFrom(unconfigured), Permission.INDEX).allowed).toBe(true);
    expect(authorize(localOperatorFrom(unconfigured), Permission.READ).allowed).toBe(true);
  });

  it('may not mutate, configure or administer providers', () => {
    // Indexing a repository the operator owns is not a privileged act. Changing
    // what Ferret believes is, and EPIC-069's confirmation is a separate control
    // besides.
    for (const permission of [
      Permission.MUTATE,
      Permission.CONFIG_WRITE,
      Permission.PROVIDER_ADMIN,
    ]) {
      expect(authorize(LOCAL_OPERATOR_PRINCIPAL, permission).allowed, permission).toBe(false);
    }
  });

  it('is an operator rather than an AI client, and says so in a denial', () => {
    expect(LOCAL_OPERATOR_PRINCIPAL.class).toBe(PrincipalClass.OPERATOR);
    expect(LOCAL_OPERATOR_PRINCIPAL.id).toBe('ferret.local-operator');
  });

  it('holds no permission scope, so scoped content stays hidden from the CLI too', () => {
    expect(LOCAL_OPERATOR_PRINCIPAL.permittedScopes).toStrictEqual([]);
  });

  it('yields to configuration wherever configuration speaks — AC-4', () => {
    // Not a second grant surface. The moment an `authorization` block exists,
    // the CLI reads exactly what the MCP surface reads, through the same
    // function — which is what makes `ferret index` deniable for the first time.
    const locked = ferretConfigSchema.parse({ authorization: { permissions: ['read'] } });

    expect(localOperatorFrom(locked)).toStrictEqual(principalFrom(locked));
    expect(authorize(localOperatorFrom(locked), Permission.INDEX).allowed).toBe(false);
  });

  it('refuses with NOT_PERMITTED when configuration withholds the permission — AC-3', () => {
    const locked = ferretConfigSchema.parse({ authorization: { permissions: ['read'] } });

    expect(() =>
      assertPermitted(localOperatorFrom(locked), Permission.INDEX, 'index'),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.NOT_PERMITTED }));
  });

  it('names the permission in the refusal and nothing about the repository — AC-9', () => {
    const locked = ferretConfigSchema.parse({ authorization: { permissions: ['read'] } });
    try {
      assertPermitted(localOperatorFrom(locked), Permission.INDEX, 'index');
      expect.unreachable('should have refused');
    } catch (error) {
      const serialized = JSON.stringify(error instanceof Error ? { ...error, message: error.message } : error);
      expect(serialized).toContain(Permission.INDEX);
      // A denial is a fact about the caller, never about the data behind it.
      expect(serialized).not.toContain('/');
    }
  });
});

describe('refusing an operation', () => {
  it('raises NOT_PERMITTED, distinguishably from not-found — AC-6', () => {
    try {
      assertPermitted(granted(Permission.READ), Permission.MUTATE, 'mcp.merge');
      expect.unreachable('should have refused');
    } catch (error) {
      expect((error as { code?: string }).code).toBe(ErrorCode.NOT_PERMITTED);
      expect((error as { code?: string }).code).not.toBe(ErrorCode.ENTITY_NOT_FOUND);
    }
  });

  it('does not raise for a permitted operation', () => {
    expect(() => assertPermitted(granted(Permission.READ), Permission.READ, 'mcp.search')).not.toThrow();
  });

  it('says how to fix it without saying what was behind it — AC-5', () => {
    try {
      assertPermitted(granted(), Permission.CONFIG_WRITE, 'mcp.configSet');
      expect.unreachable('should have refused');
    } catch (error) {
      const serialized = JSON.stringify(error);
      expect(serialized).toContain(Permission.CONFIG_WRITE);
      // The remediation is a configuration instruction, not a description of the
      // target. `operation` names what was refused, never what it was refused on.
      expect(serialized).toMatch(/configuration/i);
      expect(serialized).not.toMatch(/password|secret|token/i);
    }
  });
});

describe('turning a grant into a retrieval context — AC-8', () => {
  it('carries the principal scopes and selector across', () => {
    const principal: Principal = {
      ...granted(Permission.READ),
      permittedScopes: ['jira:team-a'],
      scope: { include: [{ kind: ScopeKind.REPOSITORY, id: 'repo-a' }], exclude: [] },
    };

    const access = accessContextFor(principal);

    // The single conversion, so a scope granted for reading and a scope enforced
    // on reading cannot drift apart.
    expect(access.permittedScopes).toStrictEqual(['jira:team-a']);
    expect(access.scope.include).toStrictEqual([{ kind: ScopeKind.REPOSITORY, id: 'repo-a' }]);
  });

  it('takes exclusions from configuration, never from the principal', () => {
    // Exclusion is additive and one-way (EPIC-003): a principal cannot be granted
    // *less* exclusion, and letting one carry its own would be a way to ask for
    // more.
    const config = ferretConfigSchema.parse({ exclude: ['**/*.env'] });
    const access = accessContextFor(granted(Permission.READ), config);

    expect(access.exclusions.some((rule) => rule.pattern === '**/*.env')).toBe(true);
    // Ferret's own defaults are there too, and cannot be displaced.
    expect(access.exclusions.length).toBeGreaterThan(1);
  });
});

describe('reading the grant from configuration — AC-7, AC-11', () => {
  it('gives the anonymous principal when nothing is configured', () => {
    // A Ferret nobody configured should be the restricted one.
    expect(principalFrom(ferretConfigSchema.parse({}))).toStrictEqual(ANONYMOUS_PRINCIPAL);
  });

  it('reads what configuration granted', () => {
    const config = ferretConfigSchema.parse({
      authorization: {
        principalId: 'claude-code',
        principalClass: 'agent',
        permissions: ['read', 'index'],
        permittedScopes: ['jira:team-a'],
      },
    });

    const principal = principalFrom(config);

    expect(principal.id).toBe('claude-code');
    expect(authorize(principal, Permission.INDEX).allowed).toBe(true);
    expect(authorize(principal, Permission.MUTATE).allowed).toBe(false);
    expect(principal.permittedScopes).toStrictEqual(['jira:team-a']);
  });

  it('produces the same principal from the same grant written differently', () => {
    // Sorted and deduplicated, which is what makes a decision reproducible: two
    // configurations that grant the same thing must not produce principals that
    // compare unequal.
    const one = principalFrom(
      ferretConfigSchema.parse({ authorization: { permissions: ['index', 'read', 'read'] } }),
    );
    const other = principalFrom(
      ferretConfigSchema.parse({ authorization: { permissions: ['read', 'index'] } }),
    );

    expect(one).toStrictEqual(other);
  });

  it('refuses a misspelled permission at composition — AC-11', () => {
    // A typo that quietly denied would look like a broken product, and one that
    // quietly allowed would be worse. The message names the known vocabulary so
    // the operator does not have to find it.
    const config = ferretConfigSchema.parse({ authorization: { permissions: ['read', 'wrtie'] } });

    try {
      principalFrom(config);
      expect.unreachable('should have refused');
    } catch (error) {
      expect((error as { code?: string }).code).toBe(ErrorCode.CONFIG_INVALID);
      expect(JSON.stringify(error)).toContain('wrtie');
      expect(JSON.stringify(error)).toContain(Permission.CONFIG_WRITE);
    }
  });

  it('refuses a grant naming an unknown principal class', () => {
    expect(() =>
      ferretConfigSchema.parse({ authorization: { principalClass: 'root' } }),
    ).toThrow();
  });

  it('refuses a grant with a field nobody defined', () => {
    // `.strict()`: a grant with `permisions` misspelled must not silently be an
    // empty grant that happens to deny everything for the wrong reason.
    expect(() =>
      ferretConfigSchema.parse({ authorization: { permisions: ['read'] } }),
    ).toThrow();
  });

  it('is not widened by anything a caller could say about itself', () => {
    // Governance §12: the grant comes from configuration only. There is no field
    // on a request, and nothing indexed, that reaches this function — asserted by
    // its signature, and by the absence of any other caller.
    const config = ferretConfigSchema.parse({
      authorization: { permissions: [], permittedScopes: [] },
    });
    const principal = principalFrom(config);

    for (const permission of PERMISSIONS) {
      expect(authorize(principal, permission).allowed, permission).toBe(false);
    }
  });
});
