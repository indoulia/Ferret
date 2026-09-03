import { z } from 'zod';

import { Capability } from './capabilities.js';
import {
  MINIMUM_PROVIDER_CONTRACT_VERSION,
  PROVIDER_CONTRACT_VERSION,
  isSupportedContractVersion,
} from './contract.js';

/**
 * What a provider package declares about itself — EPIC-074 §8.2.
 *
 * EPIC-013's discovery loads a module and *then* validates the provider it
 * exports. That order has a consequence nobody had written down: a package
 * built for a future Ferret runs its top-level code in this one before being
 * refused. Importing is executing, and the refusal arrives after the fact.
 *
 * A manifest is read from the package's own `package.json` — data, not code —
 * so Ferret can decline before `import()`.
 *
 * **It is a compatibility courtesy, not a security boundary.** The package
 * writes its own manifest; a hostile one simply lies. What authorises loading a
 * module is the user naming it in configuration, exactly as EPIC-013 says, and
 * nothing here changes that. What this buys is that an *honest* incompatible
 * package fails with a sentence instead of a stack trace.
 */

/** The `ferret` field of a provider package's `package.json`. */
export const providerManifestSchema = z
  .object({
    /** The provider id the module will register. */
    id: z.string().min(1),
    /** The contract version the package was written against. */
    contractVersion: z.number().int().min(1),
    /** What it intends to offer. Advisory: the provider's own declaration wins. */
    capabilities: z.array(z.enum(Object.values(Capability) as [string, ...string[]])).default([]),
    /** A one-line description, for `ferret doctor`. */
    description: z.string().optional(),
  })
  .strict();

export type ProviderManifest = z.infer<typeof providerManifestSchema>;

/** Why a package cannot be loaded. A value, so a caller does not parse prose. */
export const ManifestRefusal = {
  /** No `ferret.provider` field. Not a Ferret provider package. */
  ABSENT: 'absent',
  /** Present and not the shape a manifest has. */
  MALFORMED: 'malformed',
  /** Written against a contract version this build does not support. */
  UNSUPPORTED_CONTRACT: 'unsupported-contract',
} as const;

export type ManifestRefusal = (typeof ManifestRefusal)[keyof typeof ManifestRefusal];

export type ManifestVerdict =
  | { readonly loadable: true; readonly manifest: ProviderManifest }
  | { readonly loadable: false; readonly refusal: ManifestRefusal; readonly detail: string };

/**
 * Read a package's manifest and decide whether to import it.
 *
 * Takes the parsed `package.json` rather than a path: reading a file is the
 * caller's, and this stays a pure function that a test can drive with an object.
 *
 * **`ABSENT` is not a refusal to load.** A package with no manifest is one that
 * predates this Epic or simply did not write one, and EPIC-013's behaviour —
 * import, then validate — remains correct for it. Refusing every unmanifested
 * package would break every provider written before this sentence.
 */
export function readProviderManifest(packageJson: unknown): ManifestVerdict {
  if (typeof packageJson !== 'object' || packageJson === null) {
    return { loadable: false, refusal: ManifestRefusal.MALFORMED, detail: 'Not an object.' };
  }
  const ferret = (packageJson as { ferret?: unknown }).ferret;
  if (ferret === undefined) {
    return {
      loadable: false,
      refusal: ManifestRefusal.ABSENT,
      detail: 'The package declares no `ferret.provider` manifest.',
    };
  }
  if (typeof ferret !== 'object' || ferret === null) {
    return {
      loadable: false,
      refusal: ManifestRefusal.MALFORMED,
      detail: 'The `ferret` field is not an object.',
    };
  }

  const parsed = providerManifestSchema.safeParse((ferret as { provider?: unknown }).provider);
  if (!parsed.success) {
    return {
      loadable: false,
      refusal: ManifestRefusal.MALFORMED,
      // The issue paths, not the values: a manifest is a package's own file and
      // echoing its contents into an error is echoing untrusted text.
      detail: `The manifest is not valid: ${parsed.error.issues
        .map((issue) => issue.path.join('.') || '(root)')
        .join(', ')}`,
    };
  }

  if (!isSupportedContractVersion(parsed.data.contractVersion)) {
    return {
      loadable: false,
      refusal: ManifestRefusal.UNSUPPORTED_CONTRACT,
      detail: `The package targets provider contract version ${String(parsed.data.contractVersion)}; this build supports ${String(MINIMUM_PROVIDER_CONTRACT_VERSION)}–${String(PROVIDER_CONTRACT_VERSION)}.`,
    };
  }

  return { loadable: true, manifest: parsed.data };
}

/**
 * Whether a verdict should stop an import.
 *
 * Only an explicit incompatibility does. An absent manifest is silence, and a
 * malformed one is a package that got its own metadata wrong — neither is
 * evidence that the *code* will not work, and refusing on either would make
 * this Epic a breaking change for every existing provider.
 */
export function refusesImport(verdict: ManifestVerdict): boolean {
  return !verdict.loadable && verdict.refusal === ManifestRefusal.UNSUPPORTED_CONTRACT;
}
