/**
 * Types for the build script, so a test can import its grammar list.
 *
 * The script is plain Node — it runs before and independently of `tsc` — but
 * `tests/unit/code-parser.test.ts` imports `GRAMMARS` to assert it matches the
 * list the parser derives from its language table. Without this the import is
 * implicitly `any` and the drift guard would compile whatever it was given.
 */
export declare const GRAMMARS: readonly string[];
