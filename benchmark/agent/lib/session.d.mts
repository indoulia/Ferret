/** Types for the session driver, so the guard test can build a trace with the driver's own classifier. */

import type { AgentSessionResult, AgentTask, AgentTraceEntry } from './grade.d.mts';

/** The built-in tool set both arms hold. */
export declare const BUILT_IN_TOOLS: string;

/** The answer contract appended to Claude Code's own system prompt, identical in both arms. */
export declare const CONTRACT: string;

/** The JSON schema one task's final message must match. */
export declare function schemaFor(task: AgentTask): Record<string, unknown>;

/** A trace entry in the shape the scoring reads, from one Claude Code tool call. */
export declare function classify(
  call: { readonly tool: string; readonly input: unknown; readonly at: number },
  text: string,
  isError: boolean,
): AgentTraceEntry;

/** Runs one headless Claude Code session to an answer. */
export declare function run(input: {
  readonly task: AgentTask;
  readonly arm: 'control' | 'treatment';
  readonly root: string;
  readonly cli: string;
  readonly connection: Readonly<Record<string, string>>;
  readonly configHome: string;
  readonly workdir: string;
  readonly model: string;
  readonly effort: string;
}): Promise<
  AgentSessionResult & {
    readonly isError: boolean;
    readonly apiErrorStatus: number | null;
    readonly sessionId: string | null;
    readonly costUsd: number;
    readonly stderr: string;
    readonly rawResultText: string;
  }
>;
