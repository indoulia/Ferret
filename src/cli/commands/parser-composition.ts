/**
 * Composing Ferret's own code parser into a run that asked for content.
 *
 * EPIC-108 §8.5. The parser is **discovered, not imported**: `ferret index`
 * names a module specifier and EPIC-013's `discoverProviders` loads it, which is
 * the mechanism that Epic built and this is its first production caller. The
 * consequence that matters is architectural — `boundaries.test.ts` proves the
 * CLI's *static* graph names no parser module and carries no grammar runtime,
 * so `ferret status` and `ferret config` pay nothing for a flag they do not use.
 *
 * Two things here are deliberate and are the reason this is its own module.
 *
 * **The specifier is a literal.** `import('@indoulia/ferret/parsers')` is written
 * out, not assembled, so a bundler, the package's own `exports` map and the
 * architecture scanner can all see the same edge. An edge that only exists at
 * runtime is one no review can check, and the whole value of the boundary tests
 * is that they check.
 *
 * **Any other specifier is refused rather than imported.** `discoverProviders`
 * states that "the caller owns trust in the module specifiers"; this is that
 * ownership, made total. EPIC-108 §11 requires the parser module specifier to be
 * fixed and internal, and a loader that imported whatever it was handed would
 * make that a convention rather than a property.
 */

import { FerretError, ErrorCode } from '../../errors/index.js';
import type { ProviderModuleExports, ProviderModuleLoader } from '../../providers/index.js';

/** The only module this loader will load. Ferret's own published subpath. */
export const FERRET_PARSERS_MODULE = '@indoulia/ferret/parsers';

/**
 * Loads Ferret's parser subpath and hands `discoverProviders` a fresh provider.
 *
 * A new instance per call rather than a module-level singleton, because a
 * provider carries lifecycle state: `BaseProvider` refuses to initialize again
 * once it has been shut down, so a shared instance would work for the first
 * runtime in a process and fail for the second. That is invisible in a CLI,
 * where there is one run, and immediate in a test suite, where there are many.
 */
export const loadFerretParsers: ProviderModuleLoader = async (
  specifier: string,
): Promise<ProviderModuleExports> => {
  if (specifier !== FERRET_PARSERS_MODULE) {
    throw new FerretError(
      ErrorCode.PROVIDER_INVALID,
      `Ferret loads only its own parser subpath, not "${specifier}"`,
      {
        details: { specifier, permitted: FERRET_PARSERS_MODULE },
        remediation: 'Content indexing composes one fixed, internal module. There is nothing to configure.',
      },
    );
  }

  const module = await import('@indoulia/ferret/parsers');
  // All of Ferret's parsers — EPIC-029, then EPIC-026. `providers` rather than
  // `provider` because the framework picks per file: the code parser claims what
  // its grammars cover natively, the PDF parser claims `application/pdf` and
  // nothing else, and the text parser claims Markdown natively and other text as
  // a fallback. Only the last one offers a fallback, so none can displace
  // another — which is what `ParserSupport` is for.
  return {
    providers: [
      module.createCodeParserProvider(),
      module.createPdfParserProvider(),
      module.createTextParserProvider(),
    ],
  };
};
