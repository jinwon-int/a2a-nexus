import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Loader for the patch-command profile scripts extracted out of `config.ts`
 * (a2a-nexus#2049).
 *
 * The runner scripts that execute inside a task container used to live as
 * ~1.15k lines of TypeScript template literals. As real `profiles/*.sh` files
 * they are reachable by `bash -n`/shellcheck and a change to a runner script
 * reviews as a script diff instead of an escaped-string diff.
 *
 * ## Runtime loading contract
 *
 * `dist/` must be self-contained: `package.json` `files` ships `dist`, and the
 * supported install path is a source checkout built with `npm run build`.
 * `npm run build` therefore runs `scripts/sync-profiles.mjs` after `tsc` to
 * mirror `profiles/` into `dist/profiles/`, and this module resolves the
 * directory relative to its own compiled location (`dist/profile-scripts.js`
 * -> `dist/profiles/`). No `dist`-relative `../` escape, so copying `dist/`
 * alone still yields a working runner. `patch-command-script-goldens.test.ts`
 * fails closed if the mirror is missing or drifts from `profiles/`.
 *
 * ## Interpolation contract
 *
 * Every substitution point in the original template literal was a plain
 * identifier, so each one becomes a `__A2A_PROFILE_<name>__` token — a valid
 * bash word, which is why the templates still parse. `renderProfileScript`
 * does exactly one left-to-right pass with a function replacer, so a
 * substituted value is never rescanned and `$&`/`$'` inside a value cannot be
 * reinterpreted. That makes the rendered output byte-identical to the old
 * template literal by construction; `patch-command-script-goldens.test.ts`
 * proves it against goldens captured before the extraction.
 */

/** Profiles whose container script lives in `profiles/<name>.sh`. */
export type ProfileScriptName = "codex" | "claude-code" | "hermes" | "openclaw";

/** Every extracted profile, in the order `config.ts` dispatches them. */
export const PROFILE_SCRIPT_NAMES: readonly ProfileScriptName[] = Object.freeze([
  "openclaw",
  "hermes",
  "claude-code",
  "codex",
]);

/** Substitution token emitted for each interpolation slot in a profile script. */
export const PROFILE_PLACEHOLDER_PATTERN = /__A2A_PROFILE_([A-Za-z][A-Za-z0-9]*)__/g;

/** Directory holding the profile scripts, resolved next to this module. */
export const PROFILE_SCRIPT_DIR = join(dirname(fileURLToPath(import.meta.url)), "profiles");

const templateCache = new Map<ProfileScriptName, string>();

/** Read `profiles/<name>.sh` verbatim (cached; no substitution applied). */
export function readProfileScriptTemplate(name: ProfileScriptName): string {
  const cached = templateCache.get(name);
  if (cached !== undefined) return cached;
  const file = join(PROFILE_SCRIPT_DIR, `${name}.sh`);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `runner profile script is missing: ${file} (${reason}). `
      + "Run `npm run build` in packages/docker-runner so dist/profiles is populated.",
    );
  }
  templateCache.set(name, text);
  return text;
}

/**
 * Render a profile script by replacing every `__A2A_PROFILE_<name>__` token
 * with `vars[name]`.
 *
 * Fails closed on both sides of the contract: an unknown token throws, and a
 * supplied variable that no token consumes throws too. Either would otherwise
 * silently ship a runner script that lost a value.
 */
export function renderProfileScript(name: ProfileScriptName, vars: Record<string, string>): string {
  const template = readProfileScriptTemplate(name);
  const consumed = new Set<string>();
  const rendered = template.replace(PROFILE_PLACEHOLDER_PATTERN, (_match, key: string) => {
    const value = vars[key];
    if (value === undefined) {
      throw new Error(`runner profile ${name}.sh references unknown substitution __A2A_PROFILE_${key}__`);
    }
    consumed.add(key);
    return value;
  });
  const unused = Object.keys(vars).filter((key) => !consumed.has(key));
  if (unused.length > 0) {
    throw new Error(`runner profile ${name}.sh ignores supplied substitution(s): ${unused.sort().join(", ")}`);
  }
  return rendered;
}
