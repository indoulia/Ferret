/**
 * Types for the benchmark's artefact naming, so its guard test can import it.
 *
 * `tests/unit/benchmark-tasks.test.ts` asserts what the harness excludes from
 * the corpus it searches, and that no file outside that exclusion quotes a task
 * question. Both assertions are about `EXCLUDED_PREFIXES` and `withinCorpus`
 * specifically, so an implicitly `any` import would let them pass against
 * anything.
 */

/** Repository path prefixes that are the harness rather than the corpus. */
export declare const EXCLUDED_PREFIXES: readonly string[];

/** Whether an artefact is part of the corpus rather than the harness. */
export declare function withinCorpus(artefact: string): boolean;

export declare function fileArtefact(path: string): string;
export declare function commitArtefact(sha: string): string;
export declare function contextArtefact(id: string): string;
export declare function entityArtefact(entity: unknown): string | undefined;
export declare function dedupe(artefacts: readonly (string | undefined)[]): string[];
