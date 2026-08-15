/**
 * Keyring file loading for the NCLEX evaluation surface (#1724).
 *
 * Extracted from the broker server during the #1601 first-slice package
 * extraction; the file format and error messages are unchanged so operator
 * runbooks and error expectations stay stable.
 */
import { readFileSync } from "node:fs";

import type { NclexEvaluationKeyring } from "./receipt-contract.js";

export function loadNclexEvaluationKeyringFromFile(file: string): NclexEvaluationKeyring {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `nclex evaluation keyring file unreadable: ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const keys = (parsed as Record<string, unknown> | null)?.keys;
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) {
    throw new Error(`nclex evaluation keyring file must be { "keys": { "<kid>": "<spki pem>" } }: ${file}`);
  }
  const entries = Object.entries(keys as Record<string, unknown>);
  if (entries.length === 0 || !entries.every(([kid, pem]) => kid.trim() && typeof pem === "string" && pem.includes("BEGIN PUBLIC KEY"))) {
    throw new Error(`nclex evaluation keyring must map non-empty kid values to SPKI PEM strings: ${file}`);
  }
  return Object.fromEntries(entries.map(([kid, pem]) => [kid.trim(), (pem as string).trim()]));
}
