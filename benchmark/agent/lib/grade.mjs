/** The scoring, fixed before the comparison was run. */

/** Characters of a commit id a citation reduces to. */
const ABBREV = 7;

/** A citation reduced to the artefact vocabulary `benchmark/lib/identity.mjs` uses. */
export function normalizeCitation(raw) {
  if (typeof raw !== 'string') return undefined;
  let text = raw.trim();
  if (text.length === 0) return undefined;

  // Already in artefact form.
  const prefixed = /^(file|commit|pr|context):(.+)$/i.exec(text);
  if (prefixed !== null) {
    const kind = prefixed[1].toLowerCase();
    const rest = prefixed[2].trim();
    if (kind === 'file') {
      return `file:${rest
        .replace(/\s*\([^)]*\)\s*$/, '')
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/:\d+(-\d+)?$/, '')}`;
    }
    if (kind === 'commit') return `commit:${rest.slice(0, ABBREV).toLowerCase()}`;
    if (kind === 'pr') return `pr:${rest.replace(/^#/, '')}`;
    return `context:${rest}`;
  }

  // A GitHub pull request URL, or a bare reference to one.
  const url = /github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/i.exec(text);
  if (url !== null) return `pr:${url[1]}`;
  const hash = /^(?:pull request|pr)?\s*#(\d+)$/i.exec(text);
  if (hash !== null) return `pr:${hash[1]}`;

  // A trailing line reference names the same artefact: "(lines 73-91)", ":130".
  text = text
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  const line = /^(.+?):(\d+)(?:-(\d+))?$/.exec(text);
  if (line !== null && /[./]/.test(line[1])) text = line[1];

  if (/^[0-9a-f]{7,40}$/i.test(text)) return `commit:${text.slice(0, ABBREV).toLowerCase()}`;
  if (/[/.]/.test(text)) return `file:${text}`;
  // A durable context identifier, or something the harness cannot name. Kept as
  // written so it can be checked against the trace rather than discarded.
  return `context:${text}`;
}

/** Every distinct artefact the answer cited, in order. */
function citationsOf(answer) {
  const seen = new Set();
  const out = [];
  for (const raw of answer?.citations ?? []) {
    const artefact = normalizeCitation(raw);
    if (artefact === undefined || seen.has(artefact)) continue;
    seen.add(artefact);
    out.push({ artefact, raw });
  }
  return out;
}

/** Whether the trace ever put this artefact in front of the model. */
function inTrace(artefact, haystack) {
  const [kind, ...rest] = artefact.split(':');
  const value = rest.join(':');
  if (kind === 'file') return haystack.includes(value);
  if (kind === 'commit') return haystack.includes(value.slice(0, ABBREV));
  if (kind === 'pr') return haystack.includes(`#${value}`) || haystack.includes(`/pull/${value}`);
  return haystack.includes(value);
}

function matches(patterns, text) {
  return patterns.some((pattern) => new RegExp(pattern, 'i').test(text));
}

/** One graded result. */
export function grade({ task, result }) {
  const answer = result.answer;
  const answered = answer !== undefined;
  const prose = answered
    ? [answer.conclusion ?? '', ...(answer.key_facts ?? [])].join('\n')
    : '';

  // Everything a tool returned *and* every argument it was called with. The
  // argument matters more: a path passed to Read is proof the agent opened that
  // file, and Read returns numbered content without repeating the path.
  // Separators are normalised because Grep reports absolute Windows paths while
  // a citation is written with forward slashes.
  const haystack = result.trace
    .flatMap((entry) => [entry.text, JSON.stringify(entry.input ?? {})])
    .join('\n')
    .replace(/\\\\/g, '/')
    .replace(/\\/g, '/');

  const facts = (task.facts ?? []).map((fact) => ({
    id: fact.id,
    covered: answered && matches(fact.patterns, prose),
  }));
  // Staleness has two shapes, and the first is worth preferring wherever a task has it.
  const staleOption = task.verdict?.stale;
  const staleVerdict =
    staleOption === undefined ? undefined : answered && answer.verdict === staleOption;
  const stale = (task.stale ?? []).map((trap) => ({
    id: trap.id,
    asserted: answered && matches(trap.patterns, prose),
  }));

  const cited = citationsOf(answer);
  const expected = task.evidence ?? [];
  const primary = expected.filter((entry) => entry.relevance === 3).map((entry) => entry.artefact);
  const labelled = new Set(expected.map((entry) => entry.artefact));
  const citedSet = new Set(cited.map((entry) => entry.artefact));

  const unsupported = cited.filter((entry) => !inTrace(entry.artefact, haystack));
  const offLabel = cited.filter((entry) => !labelled.has(entry.artefact));

  // `StructuredOutput` is how the final answer is delivered, not investigation, so
  // it is counted apart from the work the agent did to reach it.
  const work = result.trace.filter((entry) => entry.tool !== 'StructuredOutput');
  const reads = work.filter((entry) => entry.read !== undefined);
  const ferret = work.filter((entry) => entry.ferret !== undefined);
  const surfaces = {};
  for (const entry of ferret) surfaces[entry.tool] = (surfaces[entry.tool] ?? 0) + 1;

  const primaryCited = primary.filter((artefact) => citedSet.has(artefact));

  return {
    task: task.id,
    group: task.group,

    // 1. Task success.
    answered,
    stopped: result.stopped,
    verdict: answered ? (answer.verdict ?? null) : null,
    verdictCorrect:
      task.verdict === undefined ? undefined : answered && answer.verdict === task.verdict.expected,
    factsCovered: facts.filter((fact) => fact.covered).length,
    factsTotal: facts.length,
    factsComplete: facts.length > 0 && facts.every((fact) => fact.covered),
    facts,

    // 2. Evidence quality.
    evidenceSourced: primary.length > 0 && primaryCited.length === primary.length,
    primaryCited: primaryCited.length,
    primaryTotal: primary.length,
    citations: cited.map((entry) => entry.artefact),
    citationsOffLabel: offLabel.length,

    // 3. Rediscovery cost.
    toolCalls: work.length,
    turns: result.usage.turns,
    filesRead: new Set(reads.map((entry) => entry.read.path)).size,
    linesRead: reads.reduce((total, entry) => total + entry.read.lines, 0),
    searches: work.filter((entry) => entry.search !== undefined).length,
    historyCalls: work.filter((entry) => entry.log !== undefined || entry.show !== undefined).length,
    ferretCalls: ferret.length,
    refusals: work.filter((entry) => entry.refused === true).length,
    toolErrors: work.filter((entry) => entry.isError === true).length,

    // 4.
    contextTokens:
      result.usage.inputTokens + result.usage.cacheReadTokens + result.usage.outputTokens,
    inputTokens: result.usage.inputTokens,
    cacheReadTokens: result.usage.cacheReadTokens,
    cacheWriteTokens: result.usage.cacheWriteTokens,
    outputTokens: result.usage.outputTokens,
    nudges: result.usage.nudges,

    // 5. Unsupported claims.
    unsupportedCitations: unsupported.length,
    unsupported: unsupported.map((entry) => entry.artefact),

    // 6. Staleness.
    staleAsserted:
      staleVerdict === undefined && stale.length === 0
        ? undefined
        : staleVerdict === true || stale.some((trap) => trap.asserted),
    staleVerdict,
    stale,

    // 7. Latency.
    elapsedMs: result.elapsedMs,
    toolMs: work.reduce((total, entry) => total + entry.ms, 0),

    // 8. Which Ferret surfaces were used, if any.
    ferretSurfaces: surfaces,
  };
}

function rate(list, pick) {
  const applicable = list.map(pick).filter((value) => value !== undefined);
  if (applicable.length === 0) return undefined;
  return {
    rate: applicable.filter(Boolean).length / applicable.length,
    of: applicable.length,
  };
}

function sum(list, pick) {
  return list.reduce((total, one) => total + (pick(one) ?? 0), 0);
}

function median(values) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/** One arm's numbers, over the tasks it was run on. */
export function summarize(graded) {
  const n = graded.length;
  return {
    tasks: n,
    answered: rate(graded, (one) => one.answered),
    verdictCorrect: rate(graded, (one) => one.verdictCorrect),
    factsComplete: rate(graded, (one) => (one.factsTotal > 0 ? one.factsComplete : undefined)),
    factsCovered: n === 0 ? undefined : sum(graded, (one) => one.factsCovered) / Math.max(1, sum(graded, (one) => one.factsTotal)),
    evidenceSourced: rate(graded, (one) => (one.primaryTotal > 0 ? one.evidenceSourced : undefined)),
    primaryCited:
      n === 0 ? undefined : sum(graded, (one) => one.primaryCited) / Math.max(1, sum(graded, (one) => one.primaryTotal)),
    staleAsserted: rate(graded, (one) => one.staleAsserted),
    unsupportedCitations: sum(graded, (one) => one.unsupportedCitations),
    toolCallsPerTask: n === 0 ? undefined : sum(graded, (one) => one.toolCalls) / n,
    filesReadPerTask: n === 0 ? undefined : sum(graded, (one) => one.filesRead) / n,
    linesReadPerTask: n === 0 ? undefined : Math.round(sum(graded, (one) => one.linesRead) / n),
    searchesPerTask: n === 0 ? undefined : sum(graded, (one) => one.searches) / n,
    ferretCallsPerTask: n === 0 ? undefined : sum(graded, (one) => one.ferretCalls) / n,
    contextTokens: sum(graded, (one) => one.contextTokens),
    contextTokensPerTask: n === 0 ? undefined : Math.round(sum(graded, (one) => one.contextTokens) / n),
    inputTokens: sum(graded, (one) => one.inputTokens),
    cacheReadTokens: sum(graded, (one) => one.cacheReadTokens),
    outputTokens: sum(graded, (one) => one.outputTokens),
    medianElapsedMs: median(graded.map((one) => one.elapsedMs)),
    medianTurns: median(graded.map((one) => one.turns)),
    // Cost is never reported on its own: a condition that answered nothing is cheapest, and the earlier benchmarks had to add exactly this ratio after th…
    contextTokensPerCorrect: (() => {
      const correct = graded.filter((one) => one.verdictCorrect === true).length;
      if (correct === 0) return undefined;
      return Math.round(sum(graded, (one) => one.contextTokens) / correct);
    })(),
    ferretSurfaces: graded.reduce((into, one) => {
      for (const [name, count] of Object.entries(one.ferretSurfaces)) {
        into[name] = (into[name] ?? 0) + count;
      }
      return into;
    }, {}),
  };
}
