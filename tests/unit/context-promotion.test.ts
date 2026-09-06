import { describe, expect, it } from 'vitest';

import {
  Confidence,
  ContextKind,
  LifecycleState,
  MEMORY_KINDS,
  MemoryOrigin,
  PROMOTION_PRODUCER,
  PROMOTION_SOURCE_SYSTEM,
  PromotionRefusal,
  createDurableContext,
  createEngineeringMemory,
  createSession,
  registerDurableContextKind,
  isRefusal,
  planPromotion,
  promoteMemories,
  supersede,
  type DurableContextPort,
  type EngineeringMemory,
  type StoreContextRequest,
} from '../../src/index.js';

/**
 * EPIC-129 — what a session's memories become, without a database.
 *
 * The rule is pure on purpose: what gets promoted, and what it becomes, is one
 * function rather than one per caller. The Epic's constraint — that a
 * transcript is never promoted — holds by construction here, because captures
 * are not an input.
 */

registerDurableContextKind();

const RECORDED_AT = '2026-09-06T10:00:00.000Z';

const session = createSession({
  sessionId: 'promote-1',
  provider: 'test-agent',
  actorId: 'actor-1',
  repositoryId: '00000000-0000-8000-8000-00000000repo'.slice(0, 36),
  startedAt: RECORDED_AT,
});

function memoryOf(
  statement: string,
  kind: (typeof MEMORY_KINDS)[number] = 'decision',
  origin: MemoryOrigin = MemoryOrigin.EXPLICIT,
): EngineeringMemory {
  return createEngineeringMemory({
    sessionId: session.sessionId,
    kind,
    statement,
    origin,
    recordedAt: RECORDED_AT,
    ...(origin === MemoryOrigin.EXTRACTED
      ? { rule: 'we-decided', derivedFrom: [{ captureId: 'capture-1', sequence: 1 }] }
      : {}),
  });
}

/**
 * An in-memory port. What the composition root passes is `DurableContextStore`.
 *
 * It derives its ids through `createDurableContext`, the same function the real
 * store uses, so the fake cannot disagree with the product about the one
 * property promotion depends on: identity is a function of what was said.
 */
function portOf(): DurableContextPort & { readonly requests: StoreContextRequest[] } {
  const requests: StoreContextRequest[] = [];
  const held = new Set<string>();
  return {
    requests,
    record: (request) => {
      requests.push(request);
      const built = createDurableContext({
        statement: request.statement,
        contextKind: request.contextKind,
        ...(request.scope === undefined ? {} : { scope: request.scope }),
      });
      const existed = held.has(built.entity.id);
      held.add(built.entity.id);
      return Promise.resolve({
        context: built,
        outcome: existed ? ('merged' as const) : ('created' as const),
        evidenceId: 'evidence-1',
        related: [],
        superseded: undefined,
      });
    },
    current: () => Promise.resolve([]),
    get: () => Promise.resolve(undefined),
    trust: () => Promise.resolve(undefined),
    accept: () => Promise.reject(new Error('not used')),
    archive: () => Promise.reject(new Error('not used')),
    reinstate: () => Promise.reject(new Error('not used')),
  };
}

describe('what a memory becomes', () => {
  it('promotes an explicit memory into current context', () => {
    const plan = planPromotion(memoryOf('We chose PostgreSQL over SQLite'), session);

    expect(isRefusal(plan)).toBe(false);
    if (isRefusal(plan)) return;
    expect(plan.state).toBe(LifecycleState.ACTIVE);
    expect(plan.contextKind).toBe(ContextKind.DECISION);
    expect(plan.scope).toBe(session.repositoryId);
    expect(plan.confidence).toBe(Confidence.STRONG);
  });

  it('promotes an extracted memory as a proposal, not a belief', () => {
    // A marker matched a line. That is a proposal, and EPIC-127 has a state for
    // it — so automatic extraction can never silently become current context.
    const plan = planPromotion(
      memoryOf('We decided to page history newest-first', 'decision', MemoryOrigin.EXTRACTED),
      session,
    );

    expect(isRefusal(plan)).toBe(false);
    if (isRefusal(plan)) return;
    expect(plan.state).toBe(LifecycleState.CANDIDATE);
    expect(plan.confidence).toBe(Confidence.PLAUSIBLE);
  });

  it('carries every memory kind across, so promotion loses none', () => {
    for (const kind of MEMORY_KINDS) {
      const plan = planPromotion(memoryOf(`A ${kind} worth keeping`, kind), session);
      expect(isRefusal(plan), kind).toBe(false);
      if (isRefusal(plan)) continue;
      expect(plan.contextKind, kind).toBe(kind);
    }
  });

  it('refuses a memory a later one replaced', () => {
    // Promoting it would revive a belief the session retracted.
    const first = memoryOf('The page limit is twenty');
    const second = memoryOf('The page limit is fifty');
    const { original } = supersede(first, second);

    const plan = planPromotion(original, session);

    expect(isRefusal(plan)).toBe(true);
    if (!isRefusal(plan)) return;
    expect(plan.refusal).toBe(PromotionRefusal.SUPERSEDED);
  });

  it('reports an unrecognised kind rather than failing the promotion', () => {
    const odd = { ...memoryOf('From an older row'), kind: 'speculation' } as unknown as EngineeringMemory;
    const plan = planPromotion(odd, session);

    expect(isRefusal(plan)).toBe(true);
    if (!isRefusal(plan)) return;
    expect(plan.refusal).toBe(PromotionRefusal.UNKNOWN_KIND);
  });

  it('leaves the scope absent when the session names no repository', () => {
    const unscoped = createSession({
      sessionId: 'promote-2',
      provider: 'test-agent',
      actorId: 'actor-1',
      startedAt: RECORDED_AT,
    });

    const plan = planPromotion(memoryOf('True everywhere, as far as anyone said'), unscoped);
    expect(isRefusal(plan)).toBe(false);
    if (isRefusal(plan)) return;
    expect(plan.scope).toBeUndefined();
  });
});

describe('promoting a session', () => {
  it('records each memory once, with the session as its provenance', async () => {
    const port = portOf();
    const memories = [
      memoryOf('We chose PostgreSQL over SQLite'),
      memoryOf('Never index a worktree twice because the second run reopens intervals', 'constraint'),
    ];

    const report = await promoteMemories(port, session, memories, '1.0.0');

    expect(report.considered).toBe(2);
    expect(report.created).toBe(2);
    expect(report.merged).toBe(0);
    expect(report.proposed).toBe(0);
    expect(report.refused).toStrictEqual([]);
    expect(report.contextIds).toHaveLength(2);

    for (const request of port.requests) {
      expect(request.provenance.producer).toBe(PROMOTION_PRODUCER);
      // The session it came from, so "why does Ferret believe this" reaches the
      // work that produced it rather than stopping at Ferret's own name.
      expect(request.provenance.sourceSystem).toBe(PROMOTION_SOURCE_SYSTEM);
      expect(request.provenance.sourceId).toBe(session.sessionId);
      expect(request.provenance.observedAt).toBe(RECORDED_AT);
      // Found by dogfooding: the plan computed a confidence and the request
      // dropped it, which is the exact failure EPIC-046 was raised for — a
      // number stored, read by two orderings, and never written.
      expect(request.provenance.confidence).toBe(Confidence.STRONG);
    }
  });

  it('carries a weaker confidence for a memory a rule found', async () => {
    const port = portOf();
    await promoteMemories(
      port,
      session,
      [memoryOf('We decided something a marker matched', 'decision', MemoryOrigin.EXTRACTED)],
      '1.0.0',
    );

    // 0.35 apart, which is what makes the distinction worth carrying at all.
    expect(port.requests[0]?.provenance.confidence).toBe(Confidence.PLAUSIBLE);
  });

  it('counts proposals separately from beliefs', async () => {
    const port = portOf();
    const report = await promoteMemories(
      port,
      session,
      [
        memoryOf('Stated outright'),
        memoryOf('We decided to do the other thing', 'decision', MemoryOrigin.EXTRACTED),
      ],
      '1.0.0',
    );

    expect(report.created).toBe(2);
    expect(report.proposed).toBe(1);
  });

  it('never promotes a transcript, because a capture is not an input', async () => {
    const port = portOf();
    // The whole of the Epic's forbidden case: there is no argument that could
    // carry one, and an empty memory list promotes nothing.
    const report = await promoteMemories(port, session, [], '1.0.0');

    expect(report.considered).toBe(0);
    expect(port.requests).toStrictEqual([]);
  });

  it('skips a superseded memory and says which', async () => {
    const port = portOf();
    const first = memoryOf('The page limit is twenty');
    const { original } = supersede(first, memoryOf('The page limit is fifty'));

    const report = await promoteMemories(port, session, [original, memoryOf('Still believed')], '1.0.0');

    expect(report.created).toBe(1);
    expect(report.refused).toHaveLength(1);
    expect(report.refused[0]?.refusal).toBe(PromotionRefusal.SUPERSEDED);
    expect(port.requests).toHaveLength(1);
  });

  it('promoting twice adds nothing, because merging is the identifier', async () => {
    const port = portOf();
    const memories = [memoryOf('Promoted once, promoted twice')];

    const first = await promoteMemories(port, session, memories, '1.0.0');
    const second = await promoteMemories(port, session, memories, '1.0.0');

    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(second.merged).toBe(1);
    expect(first.contextIds[0]).toBe(second.contextIds[0]);
  });
});
