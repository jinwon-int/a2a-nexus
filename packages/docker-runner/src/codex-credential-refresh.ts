import { randomUUID } from "node:crypto";
import {
  chmod,
  chown,
  copyFile,
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerConfig } from "./types.js";

const CODEX_MOUNT_TARGET = "/run/secrets/codex-dir";
const MAX_AUTH_BYTES = 1024 * 1024;
const REFRESHABLE_TOKEN_FIELDS = new Set(["access_token", "id_token", "refresh_token"]);

interface FileIdentity {
  uid: number;
  gid: number;
}

export interface CodexCredentialRuntime {
  configDir: string;
  runtimeDir: string;
  originalAuth: Buffer;
  originalIdentity: FileIdentity;
}

function authRecord(value: Buffer, label: string): Record<string, unknown> {
  if (value.byteLength === 0 || value.byteLength > MAX_AUTH_BYTES) {
    throw new Error(`${label} must be between 1 byte and ${MAX_AUTH_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.toString("utf8"));
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).sort();
}

function assertSameKeys(
  original: Record<string, unknown>,
  candidate: Record<string, unknown>,
  label: string,
): void {
  if (!isDeepStrictEqual(exactKeys(original), exactKeys(candidate))) {
    throw new Error(`${label} changed credential schema`);
  }
}

export function validateCodexAuthRefreshCandidate(originalBytes: Buffer, candidateBytes: Buffer): void {
  const original = authRecord(originalBytes, "source Codex auth.json");
  const candidate = authRecord(candidateBytes, "refreshed Codex auth.json");
  assertSameKeys(original, candidate, "refreshed Codex auth.json");

  for (const key of Object.keys(original)) {
    if (key === "last_refresh" || key === "tokens") continue;
    if (!isDeepStrictEqual(candidate[key], original[key])) {
      throw new Error(`refreshed Codex auth.json changed protected field ${key}`);
    }
  }

  if (original.tokens === undefined) return;
  if (
    !original.tokens ||
    typeof original.tokens !== "object" ||
    Array.isArray(original.tokens) ||
    !candidate.tokens ||
    typeof candidate.tokens !== "object" ||
    Array.isArray(candidate.tokens)
  ) {
    throw new Error("refreshed Codex auth.json changed tokens schema");
  }

  const originalTokens = original.tokens as Record<string, unknown>;
  const candidateTokens = candidate.tokens as Record<string, unknown>;
  assertSameKeys(originalTokens, candidateTokens, "refreshed Codex auth.json tokens");
  for (const key of Object.keys(originalTokens)) {
    if (REFRESHABLE_TOKEN_FIELDS.has(key)) {
      if (
        typeof originalTokens[key] === "string" &&
        originalTokens[key] &&
        (typeof candidateTokens[key] !== "string" || !candidateTokens[key])
      ) {
        throw new Error(`refreshed Codex auth.json emptied required token field ${key}`);
      }
      continue;
    }
    if (!isDeepStrictEqual(candidateTokens[key], originalTokens[key])) {
      throw new Error(`refreshed Codex auth.json changed protected token field ${key}`);
    }
  }
}

function numericContainerIdentity(user: string | undefined): FileIdentity | undefined {
  const trimmed = user?.trim();
  if (!trimmed || /^(?:0|root)(?::(?:0|root))?$/i.test(trimmed)) return undefined;
  const [uidText, gidText] = trimmed.split(":", 2);
  if (!/^\d+$/.test(uidText)) return undefined;
  const uid = Number(uidText);
  const gid = gidText === undefined || gidText === "" ? uid : Number(gidText);
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid < 0) return undefined;
  return { uid, gid };
}

async function requireRegularFile(path: string, label: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
  return info;
}

export async function prepareCodexCredentialRuntime(
  configDir: string,
  containerUser: string | undefined,
): Promise<CodexCredentialRuntime> {
  const authPath = join(configDir, "auth.json");
  const authInfo = await requireRegularFile(authPath, "Codex auth.json");
  const originalAuth = await readFile(authPath);
  authRecord(originalAuth, "source Codex auth.json");

  const runtimeDir = await mkdtemp(join(tmpdir(), "a2a-codex-credential-"));
  try {
    const runtimeAuthPath = join(runtimeDir, "auth.json");
    await copyFile(authPath, runtimeAuthPath);
    await chmod(runtimeAuthPath, 0o600);

    const configPath = join(configDir, "config.toml");
    try {
      await requireRegularFile(configPath, "Codex config.toml");
      const runtimeConfigPath = join(runtimeDir, "config.toml");
      await copyFile(configPath, runtimeConfigPath);
      await chmod(runtimeConfigPath, 0o600);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "ENOENT") throw error;
    }

    const containerIdentity = numericContainerIdentity(containerUser);
    if (containerIdentity) {
      await chown(runtimeDir, containerIdentity.uid, containerIdentity.gid);
      await chown(runtimeAuthPath, containerIdentity.uid, containerIdentity.gid);
      const runtimeConfigPath = join(runtimeDir, "config.toml");
      try {
        await chown(runtimeConfigPath, containerIdentity.uid, containerIdentity.gid);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (code !== "ENOENT") throw error;
      }
    }

    return {
      configDir,
      runtimeDir,
      originalAuth,
      originalIdentity: { uid: Number(authInfo.uid), gid: Number(authInfo.gid) },
    };
  } catch (error) {
    await rm(runtimeDir, { recursive: true, force: true });
    throw error;
  }
}

export function withCodexCredentialRuntime(
  config: RunnerConfig,
  runtime: CodexCredentialRuntime,
): RunnerConfig {
  let replaced = false;
  const extraMounts = (config.extraMounts ?? []).map((mount) => {
    const target = mount.target.replace(/\/+$/, "") || "/";
    if (target !== CODEX_MOUNT_TARGET) return mount;
    replaced = true;
    return { ...mount, source: runtime.runtimeDir, readOnly: false };
  });
  if (!replaced) {
    throw new Error("Codex credential runtime requires the canonical /run/secrets/codex-dir mount");
  }
  return { ...config, extraMounts };
}

export async function commitCodexCredentialRefresh(runtime: CodexCredentialRuntime): Promise<boolean> {
  const candidatePath = join(runtime.runtimeDir, "auth.json");
  await requireRegularFile(candidatePath, "refreshed Codex auth.json");
  const candidateAuth = await readFile(candidatePath);
  validateCodexAuthRefreshCandidate(runtime.originalAuth, candidateAuth);
  if (candidateAuth.equals(runtime.originalAuth)) return false;

  const destination = join(runtime.configDir, "auth.json");
  const atomicPath = join(runtime.configDir, `.auth.json.a2a-${randomUUID()}`);
  try {
    await writeFile(atomicPath, candidateAuth, { flag: "wx", mode: 0o600 });
    const atomicInfo = await lstat(atomicPath);
    if (
      Number(atomicInfo.uid) !== runtime.originalIdentity.uid ||
      Number(atomicInfo.gid) !== runtime.originalIdentity.gid
    ) {
      await chown(atomicPath, runtime.originalIdentity.uid, runtime.originalIdentity.gid);
    }
    await chmod(atomicPath, 0o600);
    await rename(atomicPath, destination);
  } catch (error) {
    await rm(atomicPath, { force: true });
    throw error;
  }
  return true;
}

export async function cleanupCodexCredentialRuntime(runtime: CodexCredentialRuntime): Promise<void> {
  await rm(runtime.runtimeDir, { recursive: true, force: true });
}
