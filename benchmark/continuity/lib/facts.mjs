/**
 * Whether what arrived actually says what the answer needs.
 *
 * Artefact recall cannot separate a condition that returned the right record
 * from one that returned the right record with the reasoning stripped out — and
 * the second is cheaper on every cost measure, so a benchmark reporting only
 * recall and tokens would rank it higher for carrying less. That is not a
 * hypothetical: `ferret_context_record` takes a statement and has no field for
 * the reasoning behind it, and promotion drops the `rationale` the session tier
 * collected, so the cheaper-and-emptier condition is a real one.
 *
 * Checking it is possible here in a way it was not in the task benchmark. There
 * an artefact was a path the agent still had to open, so what an answer would
 * rest on could only be inferred from what was pointed at. Here the artefact
 * **is** the text: it arrives in the response. So the facts a complete answer
 * needs are matched against what the condition actually put in front of the
 * agent, with no model in the loop and nothing inferred.
 *
 * Matching is a case-insensitive substring, and each fact lists the surface
 * forms that count. Deliberately blunt: a fuzzier matcher would be a second
 * thing that can be wrong, and a fact whose forms are all absent from the
 * scenario is caught by `tests/unit/continuity-tasks.test.ts` rather than
 * quietly scoring zero for ever.
 */

/** The required facts of `task` present in `deliveredText`. */
export function factsIn(task, deliveredText) {
  const haystack = deliveredText.toLowerCase();
  const found = (task.requiredFacts ?? []).map((fact) => ({
    id: fact.id,
    present: fact.any.some((form) => haystack.includes(form.toLowerCase())),
  }));
  return {
    /**
     * Every fact a complete answer needs was in front of the agent.
     *
     * `false` for a task that requires nothing, rather than vacuously true: a
     * task with no required facts is an unlabelled task, and counting it as
     * answered would let an unlabelled suite report a perfect score.
     */
    answered: found.length > 0 && found.every((one) => one.present),
    factsFound: found.filter((one) => one.present).length,
    factsTotal: found.length,
    missingFacts: found.filter((one) => !one.present).map((one) => one.id),
  };
}
