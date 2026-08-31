/**
 * Path facts, in one place.
 *
 * `extensionOf` lived in `git/files.ts` because EPIC-022 was the first code that
 * needed it. EPIC-030 needs the same answer from the same paths, and a second
 * implementation would eventually disagree about `.tar.gz`, about a dotfile, or
 * about a trailing dot — so it moved here and the Git provider re-exports it.
 */

/** Lowercase extension without the dot, when the path has one. */
export function extensionOf(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  // `<= 0` rather than `< 0`: a leading dot makes a name, not an extension, so
  // `.gitignore` has none.
  if (dot <= 0 || dot === name.length - 1) return undefined;
  return name.slice(dot + 1).toLowerCase();
}

/** The last segment of a path, with separators normalized. */
export function baseNameOf(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

/** The path with `\` turned into `/`, lowercased, for matching. */
export function normalizeForMatch(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}
