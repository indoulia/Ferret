# Engineering notes

## fact — EPIC-001 covers core runtime & package and its status is validated.
Recorded in session s1 by alpha.

## fact — EPIC-002 covers database bootstrap & migrations and its status is validated.
Recorded in session s1 by alpha.

## fact — EPIC-003 covers configuration engine and its status is validated.
Recorded in session s1 by alpha.

## fact — EPIC-004 covers runtime health & diagnostics and its status is validated.
Recorded in session s1 by alpha.

## fact — EPIC-005 covers technology evaluation & selection and its status is approved.
Recorded in session s1 by alpha.

## fact — EPIC-006 covers canonical entity model and its status is validated.
Recorded in session s1 by alpha.

## fact — EPIC-007 covers relationship & temporal model and its status is validated.
Recorded in session s1 by alpha.

## fact — EPIC-008 covers evidence & provenance model and its status is validated.
Recorded in session s1 by alpha.

## fact — EPIC-009 covers identity & scope model and its status is validated.
Recorded in session s1 by alpha.

## fact — EPIC-010 covers schema versioning & compatibility and its status is validated.
Recorded in session s1 by alpha.

## fact — EPIC-011 covers provider contracts and its status is approved.
Recorded in session s1 by alpha.

## fact — EPIC-012 covers provider sdk and its status is approved.
Recorded in session s1 by alpha.

## fact — EPIC-013 covers provider registry & discovery and its status is validated.
Recorded in session s1 by alpha.

## fact — EPIC-014 covers provider lifecycle & health and its status is validated.
Recorded in session s1 by alpha.

## fact — EPIC-015 covers provider configuration & secrets and its status is validated.
Recorded in session s1 by alpha.

## fact — EPIC-016 covers provider conformance testing and its status is validated.
Recorded in session s1 by alpha.

## constraint — Ferret mints a session identifier and there is no input field a client could supply one in.
Why: A client that supplied its own would make session identifiers a shared namespace, and nothing would stop it writing into another client's session.
Recorded in session s1 by alpha.

## decision — A closed transport does not end a session; only an explicit end call ends one.
Why: An editor restarting is the common case and it is not the user finishing their work. Reclaiming a crashed client's session is left to pruning on an age an operator supplies.
Recorded in session s1 by alpha.

## constraint — Recording takes the RECORD permission, raised as its own rather than overloaded onto INDEX.
Why: Storing what an agent learned is not the same act as ingesting a source, and both overload candidates were worse.
Recorded in session s1 by alpha.

## fact — EPIC-017 covers local repository discovery and its status is approved.
Recorded in session s2 by alpha.

## fact — EPIC-018 covers branch & worktree discovery and its status is approved.
Recorded in session s2 by alpha.

## fact — EPIC-019 covers git history ingestion and its status is approved.
Recorded in session s2 by alpha.

## fact — EPIC-020 covers commit & reference modeling and its status is approved.
Recorded in session s2 by alpha.

## fact — EPIC-021 covers github provider and its status is validated.
Recorded in session s2 by alpha.

## fact — EPIC-022 covers file discovery · epic-023 — file identity & content hashing and its status is approved.
Recorded in session s2 by alpha.

## fact — EPIC-024 covers parser framework and its status is validated.
Recorded in session s2 by alpha.

## fact — EPIC-025 covers code file parsing and its status is validated.
Recorded in session s2 by alpha.

## fact — EPIC-026 covers pdf intelligence and its status is validated.
Recorded in session s2 by alpha.

## fact — EPIC-027 covers office document intelligence and its status is validated.
Recorded in session s2 by alpha.

## fact — EPIC-028 covers spreadsheet intelligence and its status is validated.
Recorded in session s2 by alpha.

## fact — EPIC-029 covers text & markdown intelligence and its status is approved.
Recorded in session s2 by alpha.

## fact — EPIC-030 covers file structure & metadata and its status is validated.
Recorded in session s2 by alpha.

## fact — EPIC-031 covers incremental indexing and its status is approved.
Recorded in session s2 by alpha.

## fact — EPIC-032 covers index lifecycle & tombstones and its status is approved.
Recorded in session s2 by alpha.

## fact — EPIC-033 covers ast model and its status is validated.
Recorded in session s2 by alpha.

## decision — Evidence is keyed on who said it and durable context is keyed on what is said.
Why: Two producers stating the same thing are two observations supporting one record, not two records.
Recorded in session s2 by alpha.

## constraint — A durable statement that has stopped being true is replaced by recording its replacement with a supersedes link; nothing is deleted and no observation is rewritten.
Why: Why the position changed is worth answering, and a store that drops the replaced half cannot answer it.
Recorded in session s2 by alpha.

## constraint — Moving a statement through its lifecycle takes MUTATE, which is never granted by default, while recording one takes only RECORD.
Why: An agent may record freely and must be trusted deliberately before it can retire knowledge other people rely on.
Recorded in session s2 by alpha.

## fact — EPIC-034 covers symbol index and its status is validated.
Recorded in session s3 by beta.

## fact — EPIC-035 covers reference & relationship index and its status is approved.
Recorded in session s3 by beta.

## fact — EPIC-036 covers developer identity and its status is validated.
Recorded in session s3 by beta.

## fact — EPIC-037 covers repository context · epic-038 — worktree context and its status is validated.
Recorded in session s3 by beta.

## fact — EPIC-039 covers session model and its status is validated.
Recorded in session s3 by beta.

## fact — EPIC-040 covers session capture and its status is validated.
Recorded in session s3 by beta.

## fact — EPIC-041 covers durable checkpoints and its status is validated.
Recorded in session s3 by beta.

## fact — EPIC-042 covers decision & engineering memory and its status is validated.
Recorded in session s3 by beta.

## fact — EPIC-043 covers session recovery and its status is validated.
Recorded in session s3 by beta.

## fact — EPIC-044 covers evidence store · epic-045 — source authority and its status is validated.
Recorded in session s3 by beta.

## fact — EPIC-046 covers confidence & completeness and its status is approved.
Recorded in session s3 by beta.

## fact — EPIC-047 covers conflict detection and its status is approved.
Recorded in session s3 by beta.

## fact — EPIC-048 covers answer traceability and its status is implemented.
Recorded in session s3 by beta.

## fact — EPIC-049 covers relationship storage and its status is implemented.
Recorded in session s3 by beta.

## fact — EPIC-050 covers relationship traversal and its status is approved.
Recorded in session s3 by beta.

## fact — EPIC-051 covers cross-source entity resolution and its status is validated.
Recorded in session s3 by beta.

## fact — macOS packaging was measured rather than assumed: the packaging job ran on a macOS host in 3m47s and passed.
Why: Nineteen validation records had carried the admission that no macOS host was available to validate against.
Recorded in session s3 by beta.

## fact — EPIC-052 covers exact structured retrieval · epic-053 — full-text retrieval and its status is approved.
Recorded in session s4 by alpha.

## fact — EPIC-054 covers semantic retrieval · epic-055 — hybrid query planner and its status is approved.
Recorded in session s4 by alpha.

## fact — EPIC-056 covers ranking & reranking and its status is approved.
Recorded in session s4 by alpha.

## fact — EPIC-057 covers freshness & authority ranking and its status is approved.
Recorded in session s4 by alpha.

## fact — EPIC-058 covers permission-aware retrieval and its status is implemented.
Recorded in session s4 by alpha.

## fact — EPIC-059 covers context packs · epic-061 — token budgeting · epic-064 — mcp server · epic-065 — mcp knowledge tools and its status is approved.
Recorded in session s4 by alpha.

## fact — EPIC-060 covers answer packs and its status is implemented.
Recorded in session s4 by alpha.

## fact — EPIC-062 covers evidence selection and its status is implemented.
Recorded in session s4 by alpha.

## fact — EPIC-063 covers query explanation and its status is approved.
Recorded in session s4 by alpha.

## fact — EPIC-066 covers mcp configuration tools and its status is implemented.
Recorded in session s4 by alpha.

## fact — EPIC-067 covers mcp provider administration and its status is validated.
Recorded in session s4 by alpha.

## fact — EPIC-068 covers ai authorization model and its status is implemented.
Recorded in session s4 by alpha.

## fact — EPIC-069 covers destructive operation confirmation and its status is implemented.
Recorded in session s4 by alpha.

## fact — EPIC-070 covers ai client capability discovery and its status is validated.
Recorded in session s4 by alpha.

## fact — EPIC-071 covers jira provider and its status is validated.
Recorded in session s4 by alpha.

## fact — EPIC-072 covers pull request & review modeling and its status is validated.
Recorded in session s4 by alpha.

## decision — Durable context is read for a task with its own widened query, separate from the record search.
Why: Full text ANDs every term and a task is a sentence: seven statements bore directly on one question and the strict query reached none of them while matching one incidental commit.
Recorded in session s4 by alpha.

## decision — Routing the context pack through the query planner is rejected; the pack's deficit is budget rather than retrieval.
Why: It was tried against the standing defect, where the strict query returned one incidental commit so widening never fired, and it did not fix what it claimed to. The pack's results are a prefix of the search's.
Recorded in session s4 by alpha.

## decision — Standing context is ordered by what acting against it costs, not by relevance score.
Why: Retrieval already decided which statements belong to the question, and re-ranking them by score would put a well-worded fact above a constraint.
Recorded in session s4 by alpha.

## fact — EPIC-073 covers release & deployment modeling and its status is validated.
Recorded in session s5 by beta.

## fact — EPIC-074 covers external provider extension framework and its status is validated.
Recorded in session s5 by beta.

## fact — EPIC-075 covers sync cursor management and its status is approved.
Recorded in session s5 by beta.

## fact — EPIC-076 covers incremental source synchronization and its status is approved.
Recorded in session s5 by beta.

## fact — EPIC-077 covers event & webhook ingestion and its status is validated.
Recorded in session s5 by beta.

## fact — EPIC-078 covers periodic reconciliation and its status is validated.
Recorded in session s5 by beta.

## fact — EPIC-079 covers retry & backoff and its status is approved.
Recorded in session s5 by beta.

## fact — EPIC-080 covers idempotent ingestion and its status is approved.
Recorded in session s5 by beta.

## fact — EPIC-081 covers credential isolation and its status is approved.
Recorded in session s5 by beta.

## fact — EPIC-082 covers secret detection & exclusion and its status is approved.
Recorded in session s5 by beta.

## fact — EPIC-083 covers authorization enforcement and its status is implemented.
Recorded in session s5 by beta.

## fact — EPIC-084 covers prompt-injection resistance and its status is approved.
Recorded in session s5 by beta.

## fact — EPIC-085 covers audit events and its status is approved.
Recorded in session s5 by beta.

## fact — EPIC-086 covers postgresql storage layer and its status is approved.
Recorded in session s5 by beta.

## fact — EPIC-087 covers deduplicated content storage and its status is approved.
Recorded in session s5 by beta.

## fact — EPIC-088 covers retention & exclusion policies and its status is validated.
Recorded in session s5 by beta.

## gotcha — A benchmark that greps the repository it lives in retrieves its own answer key: ten of sixteen tasks had a harness file in the baseline's top ten.
Why: The task file holds every question and the artefacts that answer it, and the results hold the ranked names of previous runs.
Recorded in session s5 by beta.

## gotcha — A run measured against a build older than the source measures a tree that is not the working tree, and a stale result is indistinguishable from a regression.
Why: A run made after a failed rebase reported a search condition at 32% where the build under test scores 42%, and nothing about the run said which tree it had measured.
Recorded in session s5 by beta.

## fact — EPIC-089 covers backup & export and its status is validated.
Recorded in session s6 by alpha.

## fact — EPIC-090 covers data import & recovery and its status is validated.
Recorded in session s6 by alpha.

## fact — EPIC-091 covers structured logging and its status is approved.
Recorded in session s6 by alpha.

## fact — EPIC-092 covers metrics & tracing and its status is approved.
Recorded in session s6 by alpha.

## fact — EPIC-093 covers provider failure isolation and its status is approved.
Recorded in session s6 by alpha.

## fact — EPIC-094 covers index integrity & recovery and its status is approved.
Recorded in session s6 by alpha.

## fact — EPIC-095 covers operational diagnostics and its status is approved.
Recorded in session s6 by alpha.

## fact — EPIC-096 covers golden evaluation dataset and its status is implemented.
Recorded in session s6 by alpha.

## fact — EPIC-097 covers parser quality harness and its status is approved.
Recorded in session s6 by alpha.

## fact — EPIC-098 covers retrieval quality harness and its status is implemented.
Recorded in session s6 by alpha.

## fact — EPIC-099 covers provider conformance harness and its status is approved.
Recorded in session s6 by alpha.

## fact — EPIC-100 covers security regression suite and its status is approved.
Recorded in session s6 by alpha.

## fact — EPIC-101 covers performance & scale benchmarks and its status is validated.
Recorded in session s6 by alpha.

## fact — EPIC-102 covers npm distribution · epic-103 — global cli · epic-104 — ai client onboarding and its status is approved.
Recorded in session s6 by alpha.

## fact — EPIC-105 covers cross-platform packaging and its status is validated.
Recorded in session s6 by alpha.

## fact — EPIC-106 covers upgrade & migration ux and its status is validated.
Recorded in session s6 by alpha.

## gotcha — A widened search spent 1128 ms of its 1139 ms marking up rows that the row limit then discarded.
Why: The highlight was computed over whole file bodies before the limit was applied.
Recorded in session s6 by alpha.

## gotcha — The fallback that widens a search fired only when nothing at all had matched, so a single incidental match suppressed it.
Why: Five of sixteen questions filled one or two of ten slots and the widening never ran.
Recorded in session s6 by alpha.

## gotcha — The context pack charged its budget for about a third less than it actually sent, and cited every observation twice by construction.
Why: The charge was computed on the item before provenance was attached.
Recorded in session s6 by alpha.

## decision — The pack runs a second relaxed query restricted to durable statements, because ANDing every word of a task sentence reaches none of them.
Why: Restated here in a later session, in different words, without the earlier record being consulted.
Recorded in session s6 by alpha.

## fact — EPIC-107 covers docker distribution and its status is validated.
Recorded in session s7 by beta.

## fact — EPIC-108 covers content indexing integration and its status is approved.
Recorded in session s7 by beta.

## fact — EPIC-109 covers session & memory persistence and its status is implemented.
Recorded in session s7 by beta.

## fact — EPIC-110 covers `ferret session` command surface and its status is implemented.
Recorded in session s7 by beta.

## fact — EPIC-111 covers session recall over mcp and its status is implemented.
Recorded in session s7 by beta.

## fact — EPIC-112 covers session retention & redaction and its status is implemented.
Recorded in session s7 by beta.

## fact — EPIC-113 covers provider sync transport (`ferret sync`) and its status is implemented.
Recorded in session s7 by beta.

## fact — EPIC-114 covers postgresql version coverage and its status is implemented.
Recorded in session s7 by beta.

## fact — EPIC-115 covers macos packaging validation and its status is closed.
Recorded in session s7 by beta.

## fact — EPIC-116 covers session export fidelity and its status is implemented.
Recorded in session s7 by beta.

## fact — EPIC-117 covers recording a session over mcp and its status is implemented.
Recorded in session s7 by beta.

## fact — EPIC-118 covers ferret self-dogfood and its status is implemented.
Recorded in session s7 by beta.

## fact — EPIC-119 covers universal source connector contract and its status is implemented.
Recorded in session s7 by beta.

## fact — EPIC-120 covers repository connector and its status is implemented.
Recorded in session s7 by beta.

## fact — EPIC-121 covers github connector and its status is implemented.
Recorded in session s7 by beta.

## fact — EPIC-122 covers jira connector and its status is implemented.
Recorded in session s7 by beta.

## decision — What is kept out of the corpus is whatever would not exist but for the benchmark and whatever states its answers, rather than whatever sits in the benchmark's directory.
Why: The evidence report is an ordinary document in the docs tree and real repository knowledge, and it states every task's answer in prose. Indexed, it appeared twelve times across the three conditions and cost the pack five points of sourced by displacing the documents it described.
Recorded in session s7 by beta.

## decision — Do not add a macOS job to continuous integration; correct the records that claim macOS is verified instead.
Why: The owner asked for macOS packaging validation on 2026-09-05 and the same day said not to enable remote CI for it, because hosted macOS runners cost more than they want to spend on a platform that is not their priority. The coverage question was settled separately from the honesty question.
Recorded in session s7 by beta.

## fact — Every retrieval branch was normalised to the zero-to-one range, so a search hit's score is comparable across queries.
Why: The rank-order rule in the metrics module was still justifying itself with the reversed claim, and citing a line number that by then held a traversal bound.
Recorded in session s7 by beta.

## fact — EPIC-123 covers confluence connector and its status is implemented.
Recorded in session s8 by alpha.

## fact — EPIC-124 covers unified cross-source context and its status is implemented.
Recorded in session s8 by alpha.

## fact — EPIC-126 covers context merger and its status is implemented.
Recorded in session s8 by alpha.

## fact — EPIC-127 covers context lifecycle & authority and its status is implemented.
Recorded in session s8 by alpha.

## fact — EPIC-128 covers agent context bridge and its status is implemented.
Recorded in session s8 by alpha.

## fact — EPIC-129 covers durable context capture and its status is implemented.
Recorded in session s8 by alpha.

## fact — EPIC-130 covers retrieval quality and its status is implemented.
Recorded in session s8 by alpha.

## fact — EPIC-131 covers context assembly and its status is implemented.
Recorded in session s8 by alpha.

## fact — EPIC-132 covers multi-agent shared context and its status is implemented.
Recorded in session s8 by alpha.

## fact — EPIC-133 covers context governance & security and its status is implemented.
Recorded in session s8 by alpha.

## fact — EPIC-134 covers continuous self-dogfooding and its status is implemented.
Recorded in session s8 by alpha.

## preference — Run the unit tests while iterating and the full verification once immediately before a commit.
Why: Four integration files are eighty per cent of the full run and they spawn real git and real CLI processes. Measured on 2026-09-02: the full suite was run about fifteen times in one session where the unit tests would have caught the same failures in a tenth of the time.
Recorded in session s8 by alpha.

## gotcha — Windows continuous integration runs on push to the main branch rather than on a pull request, so a Windows-only break appears just after a merge rather than before it.
Why: Pull requests were cut to about three minutes from twelve. Windows was moved rather than deleted because this repository has real Windows-only history: a digest that failed only there, and a line-ending regression test that failed on the one platform it existed for.
Recorded in session s8 by alpha.

## constraint — Re-run the linter, the type check and the unit tests after a rebase and before pushing, because a green run from before the rebase proves nothing about the rebased tree.
Why: Twice in one session continuous integration caught what local verification would have, both from a sibling branch's edits vanishing when the base moved. The failure mode is silent: nothing in the rebase output says an edit disappeared.
Recorded in session s8 by alpha.

## decision — A closed transport does not end a session, and only an explicit end call ends one.
Why: Recorded again, months later, by an agent that did not check whether the store already held it.
Recorded in session s8 by alpha.

