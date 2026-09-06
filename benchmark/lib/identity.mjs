/**
 * One name for an artefact, whichever condition found it.
 *
 * The benchmark compares two retrievers that answer in different vocabularies:
 * the baseline speaks git — paths and object ids — and Ferret speaks entities,
 * which carry a generated id that changes on every re-index. Scoring them
 * against one expectation needs a third vocabulary that both reduce to, and it
 * has to be one a *label* can be written in, because a label keyed on a
 * generated id would be a snapshot of one run rather than a statement about the
 * repository. `src/evaluation/dataset.ts` makes the same argument for the
 * golden dataset and resolves source identity for the same reason.
 *
 * So an artefact is named by what git calls it:
 *
 *     file:docs/EPICs/EPIC-115-macOS-Packaging-Validation.md
 *     commit:271be926b0
 *     context:<durable context id>
 *
 * A commit is abbreviated to ten characters because that is what a person
 * writing a label will copy from `git log --oneline`, and because the two
 * conditions report different lengths.
 */

/** Characters of a commit id an artefact name carries. */
const ABBREV = 10;

/**
 * What is not part of the corpus being searched.
 *
 * The benchmark lives in the repository it measures, so `tasks.json` holds every
 * question *and its answer key*, and `results/` holds the ranked artefact names
 * of previous runs. Found by running it: after the first commit, ten of sixteen
 * tasks had a `benchmark/` file in the baseline's top ten, matching on the words
 * of the question it had itself been written from. Ferret was untouched only
 * because its index predated the commit — so the same contamination was about to
 * arrive on the other side at the next re-index, and the two conditions were
 * being scored against different trees in the meantime.
 *
 * A question's own answer key is not evidence. It is excluded from **both**
 * conditions by the same list, and what each condition returned from it is
 * counted rather than quietly dropped, so the contamination stays visible.
 *
 * The evidence report is on the list for the same reason and by a harder route:
 * it is an ordinary document in `docs/evidence/`, it is real repository
 * knowledge, and it states every task's answer in prose. Committed, it appeared
 * **twelve times** across the three conditions' results and cost `ferret-pack`
 * five points of `sourced` by displacing the documents it was describing. The
 * rule is not "the benchmark directory"; it is **what would not exist but for
 * the benchmark, and what states its answers**.
 */
export const EXCLUDED_PREFIXES = ['benchmark/', 'docs/evidence/FERRET-DOES-IT-HELP.md'];

/** Whether an artefact is part of the corpus rather than the harness. */
export function withinCorpus(artefact) {
  if (!artefact.startsWith('file:')) return true;
  const path = artefact.slice('file:'.length);
  return !EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** `file:<repository-relative path>`, forward slashes. */
export function fileArtefact(path) {
  return `file:${path.replace(/\\/g, '/')}`;
}

/** `commit:<abbreviated sha>`. */
export function commitArtefact(sha) {
  return `commit:${sha.slice(0, ABBREV)}`;
}

/** `context:<durable context id>`. */
export function contextArtefact(id) {
  return `context:${id}`;
}

/**
 * The artefact a Ferret entity is, or `undefined` for a kind no label names.
 *
 * Deliberately narrow. A `file_version` reduces to its file and a `code_symbol`
 * to the file that declares it would both be defensible, and both would let a
 * condition score a hit for returning something a reader still has to follow
 * one more hop to use. What the benchmark measures is whether the thing an
 * engineer would open came back, so only the kinds that *are* that thing count.
 */
export function entityArtefact(entity) {
  const attributes = entity?.attributes ?? {};
  switch (entity?.kind) {
    case 'file':
      return typeof attributes.path === 'string' ? fileArtefact(attributes.path) : undefined;
    case 'commit':
      return typeof attributes.sha === 'string' ? commitArtefact(attributes.sha) : undefined;
    case 'context':
      return typeof entity.id === 'string' ? contextArtefact(entity.id) : undefined;
    default:
      return undefined;
  }
}

/**
 * The same list with later duplicates removed, order preserved.
 *
 * Two entities can reduce to one artefact — a file and the file_version of it —
 * and a ranked list holding the same name twice would let a condition fill its
 * window with one document and score precision for it.
 */
export function dedupe(artefacts) {
  const seen = new Set();
  const unique = [];
  for (const artefact of artefacts) {
    if (artefact === undefined || seen.has(artefact)) continue;
    seen.add(artefact);
    unique.push(artefact);
  }
  return unique;
}
