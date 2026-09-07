/** Types for the real-agent benchmark's corpus rule, so its guard test asserts against it rather than against `any`. */

/** Every repository path prefix withheld from both arms, at read time and at index time. */
export declare const EXCLUDED: readonly string[];

/** The same list as glob patterns Ferret will match, with trailing slashes removed. */
export declare function ferretExclusions(): string[];

/** Whether a repository-relative path is withheld from both arms. */
export declare function isExcluded(path: string): boolean;
