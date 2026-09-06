import type { LifecycleState } from '../domain/index.js';

import type { ContextKind, DurableContext } from './durable.js';

/**
 * What an agent-facing durable context surface needs — EPIC-128.
 *
 * A **port**, for the reason `evidence-port.ts` is one: deciding what an agent
 * may store and read has nothing to do with PostgreSQL, and an import here would
 * give the core a database dependency at the first place it mattered.
 * `DurableContextStore` satisfies this structurally without knowing the file
 * exists, and `boundaries.test.ts` keeps proving the core reaches no `storage/`
 * module.
 *
 * It is also what makes the surface **agent-independent**, which is EPIC-128's
 * whole constraint. Nothing here names a client, a protocol or a vendor: an MCP
 * server, a CLI command and a future HTTP surface would all be adapters over the
 * same port, and none of them owns the model. The first client to use it is a
 * dogfood client, not the architecture.
 */

/**
 * How many records one read returns before it stops.
 *
 * Here rather than in the store because the agent surface has to advertise it
 * and may not import `storage/` — `boundaries.test.ts` refuses that edge.
 */
export const MAX_CONTEXT_PAGE = 200;

/**
 * What a composition that does not name a producer records instead.
 *
 * Named rather than left to each caller so an agent's statements are
 * attributable to *something* even when a composition root forgets, and so the
 * default is greppable rather than invented per call site.
 */
export const DEFAULT_CONTEXT_PRODUCER = 'ferret.agent';

/** A read that states which permission scopes the caller holds — EPIC-083. */
export interface ContextRead {
  readonly permittedScopes: readonly string[];
}

/** Where a statement came from, as an agent reports it. */
export interface AgentProvenance {
  readonly producer: string;
  readonly producerVersion: string;
  readonly sourceSystem: string;
  readonly sourceId?: string | undefined;
  readonly sourceUrl?: string | undefined;
  readonly observedAt?: string | undefined;
  readonly permissionScope?: string | undefined;
}

export interface StoreContextRequest {
  readonly statement: string;
  readonly contextKind: ContextKind;
  readonly subjectId?: string | undefined;
  readonly scope?: string | undefined;
  readonly supersedes?: string | undefined;
  /** `candidate` proposes; anything else asserts. */
  readonly state?: typeof LifecycleState.ACTIVE | typeof LifecycleState.CANDIDATE;
  readonly provenance: AgentProvenance;
}

export interface StoredContext {
  readonly context: DurableContext;
  /** `merged` when the statement was already on record. */
  readonly outcome: 'created' | 'merged';
  readonly evidenceId: string;
  readonly related: readonly { readonly id: string; readonly similarity: number; readonly contradiction: boolean }[];
  readonly superseded: string | undefined;
}

export interface FindContextRequest {
  readonly scope?: string | undefined;
  readonly contextKind?: ContextKind | undefined;
  readonly subjectId?: string | undefined;
  /** Omitted means current only. An empty list means every state. */
  readonly states?: readonly LifecycleState[] | undefined;
  readonly limit?: number;
}

/** What Ferret currently believes about one statement, and on what. */
export interface ContextBelief {
  readonly contextId: string;
  readonly state: LifecycleState;
  readonly current: boolean;
  readonly supportCount: number;
  readonly preferredEvidenceId: string | undefined;
  readonly authority: number | undefined;
  readonly confidence: number | undefined;
  readonly observedAt: string | undefined;
  readonly method: string | undefined;
  readonly undecided: boolean;
  readonly contradictedBy: readonly string[];
  readonly supersededBy: string | undefined;
  readonly supersedes: readonly string[];
  readonly reason: string;
}

/**
 * The transitions an agent may ask for.
 *
 * `supersede` is absent deliberately: replacing a statement means *stating the
 * replacement*, which is a store with `supersedes` set. A transition that
 * retired one record without recording what replaced it would leave the reader
 * a promise the graph cannot keep.
 */
export const ContextTransition = {
  ACCEPT: 'accept',
  ARCHIVE: 'archive',
  REINSTATE: 'reinstate',
} as const;

export type ContextTransition = (typeof ContextTransition)[keyof typeof ContextTransition];

export const CONTEXT_TRANSITIONS: readonly ContextTransition[] = Object.freeze(
  Object.values(ContextTransition),
);

export interface DurableContextPort {
  record(request: StoreContextRequest): Promise<StoredContext>;
  current(request: FindContextRequest): Promise<readonly DurableContext[]>;
  get(contextId: string): Promise<DurableContext | undefined>;
  trust(contextId: string, read: ContextRead): Promise<ContextBelief | undefined>;
  accept(contextId: string): Promise<DurableContext>;
  archive(contextId: string): Promise<DurableContext>;
  reinstate(contextId: string): Promise<DurableContext>;
}
