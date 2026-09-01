import { statSync } from 'node:fs';

import { userConfigPath } from './paths.js';

/**
 * What protection the configuration file actually has — EPIC-081 §8.5, AC-10.
 *
 * `writeConfigFileAtomically` opens with `0o600` and its own comment records
 * that Windows ignores the mode and the file inherits the directory ACL. Two
 * approved documents park that gap on EPIC-081 by name. Until now the only
 * evidence anyone had was the mode Ferret *requested*, which on the platform
 * this repository is developed on is not the protection it got.
 *
 * Governance §6: represent the unknown rather than manufacture certainty. So
 * this reports what is true here, including when what is true is "this platform
 * does not enforce the thing Ferret asked for".
 */

export interface ConfigProtection {
  readonly path: string;
  readonly exists: boolean;
  /** True when the POSIX mode on this file is meaningful and restrictive. */
  readonly enforced: boolean;
  /** The mode as four octal digits, or `undefined` where it means nothing. */
  readonly mode: string | undefined;
  /** One sentence, suitable for `ferret doctor`. Never a credential. */
  readonly detail: string;
}

/**
 * Reports the at-rest protection of the user configuration file.
 *
 * Reads the mode, never the contents: whether a file is readable by others is a
 * different question from what is in it, and answering the first must not
 * require opening it.
 */
export function describeConfigProtection(
  path: string = userConfigPath(),
  platform: NodeJS.Platform = process.platform,
): ConfigProtection {
  let mode: number | undefined;
  try {
    mode = statSync(path).mode;
  } catch {
    return {
      path,
      exists: false,
      enforced: false,
      mode: undefined,
      detail: 'No configuration file exists yet, so nothing is stored at rest.',
    };
  }

  const octal = (mode & 0o7777).toString(8).padStart(4, '0');

  if (platform === 'win32') {
    // Not a guess and not a failure to check: Node reports a synthesised mode
    // on Windows, and it describes nothing an ACL does. Printing `0666` here
    // would be worse than printing nothing, because it looks like a measurement.
    return {
      path,
      exists: true,
      enforced: false,
      mode: undefined,
      detail:
        'Windows ignores the 0600 mode Ferret requests; the file inherits the ACL of its directory. Protect it by restricting that directory, or keep the password out of the file with a $secret reference.',
    };
  }

  const openToOthers = (mode & 0o077) !== 0;
  return {
    path,
    exists: true,
    enforced: !openToOthers,
    mode: octal,
    detail: openToOthers
      ? `The configuration file is readable beyond its owner (mode ${octal}). Run chmod 600 on it, or keep the password out of it with a $secret reference.`
      : `The configuration file is readable only by its owner (mode ${octal}).`,
  };
}
