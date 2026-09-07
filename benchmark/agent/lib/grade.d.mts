/** Types for the real-agent benchmark's scoring, so its guard test pins what each measure means rather than asserting against `any`. */

/** A graded expectation, as `benchmark/agent/tasks.json` writes one. */
export interface AgentExpectation {
  readonly artefact: string;
  readonly relevance: number;
  readonly basis: string;
}

/** A claim a complete answer states, with the wordings that count as stating it. */
export interface AgentFact {
  readonly id: string;
  readonly patterns: readonly string[];
  readonly why: string;
}

/** A task, as far as scoring one needs it. */
export interface AgentTask {
  readonly id: string;
  readonly group: string;
  readonly question: string;
  readonly answerBasis: string;
  readonly verdict?: {
    readonly description?: string;
    readonly options: readonly string[];
    readonly expected: string;
    readonly stale?: string;
  };
  readonly facts?: readonly AgentFact[];
  readonly stale?: readonly AgentFact[];
  readonly evidence?: readonly AgentExpectation[];
}

/** One tool call a session made, as the driver records it. */
export interface AgentTraceEntry {
  readonly tool: string;
  readonly input: unknown;
  readonly ms: number;
  readonly isError: boolean;
  readonly refused: boolean;
  readonly text: string;
  readonly read?: { readonly path: string; readonly lines: number };
  readonly search?: { readonly pattern?: string; readonly matches: number };
  readonly log?: { readonly command: string };
  readonly show?: { readonly ref: string };
  readonly ferret?: { readonly name: string; readonly ok: boolean; readonly chars: number };
}

/** What the API and the driver observed of one session. */
export interface AgentSessionResult {
  readonly answer: Record<string, unknown> | undefined;
  readonly stopped: string;
  readonly trace: readonly AgentTraceEntry[];
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly turns: number;
    readonly nudges?: number;
  };
  readonly elapsedMs: number;
}

/** A rate over the tasks the measure applied to, so an inapplicable one cannot dilute it. */
export interface AgentRate {
  readonly rate: number;
  readonly of: number;
}

/** One graded session. */
export interface AgentScore {
  readonly task: string;
  readonly group: string;
  readonly answered: boolean;
  readonly stopped: string;
  readonly verdict: string | null;
  readonly verdictCorrect: boolean | undefined;
  readonly factsCovered: number;
  readonly factsTotal: number;
  readonly factsComplete: boolean;
  readonly facts: readonly { readonly id: string; readonly covered: boolean }[];
  readonly evidenceSourced: boolean;
  readonly primaryCited: number;
  readonly primaryTotal: number;
  readonly citations: readonly string[];
  readonly citationsOffLabel: number;
  readonly toolCalls: number;
  readonly turns: number;
  readonly filesRead: number;
  readonly linesRead: number;
  readonly searches: number;
  readonly historyCalls: number;
  readonly ferretCalls: number;
  readonly refusals: number;
  readonly toolErrors: number;
  readonly contextTokens: number;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly unsupportedCitations: number;
  readonly unsupported: readonly string[];
  readonly staleAsserted: boolean | undefined;
  readonly staleVerdict: boolean | undefined;
  readonly stale: readonly { readonly id: string; readonly asserted: boolean }[];
  readonly elapsedMs: number;
  readonly toolMs: number;
  readonly ferretSurfaces: Readonly<Record<string, number>>;
}

/** One arm's numbers over the sessions it ran. */
export interface AgentSummary {
  readonly tasks: number;
  readonly answered: AgentRate | undefined;
  readonly verdictCorrect: AgentRate | undefined;
  readonly factsComplete: AgentRate | undefined;
  readonly factsCovered: number | undefined;
  readonly evidenceSourced: AgentRate | undefined;
  readonly primaryCited: number | undefined;
  readonly staleAsserted: AgentRate | undefined;
  readonly unsupportedCitations: number;
  readonly toolCallsPerTask: number | undefined;
  readonly filesReadPerTask: number | undefined;
  readonly linesReadPerTask: number | undefined;
  readonly searchesPerTask: number | undefined;
  readonly ferretCallsPerTask: number | undefined;
  readonly contextTokens: number;
  readonly contextTokensPerTask: number | undefined;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly outputTokens: number;
  readonly medianElapsedMs: number | undefined;
  readonly medianTurns: number | undefined;
  readonly contextTokensPerCorrect: number | undefined;
  readonly ferretSurfaces: Readonly<Record<string, number>>;
}

/** A citation reduced to the artefact vocabulary the labels are written in. */
export declare function normalizeCitation(raw: unknown): string | undefined;

/** One graded session, from the task's rubric and the trace of what the agent actually retrieved. */
export declare function grade(input: {
  readonly task: AgentTask;
  readonly result: AgentSessionResult;
}): AgentScore;

/** One arm's numbers. */
export declare function summarize(graded: readonly Partial<AgentScore>[]): AgentSummary;
