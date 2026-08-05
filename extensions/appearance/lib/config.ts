import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type SettingsLanguage = "en" | "zh";

export interface AppearanceConfig {
  enabled: boolean;
  settingsLanguage: SettingsLanguage;
  header: boolean;
  editor: boolean;
}

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceConfig = {
  enabled: false,
  settingsLanguage: "en",
  header: true,
  editor: true,
};

export type LoadAppearanceResult = { config?: AppearanceConfig; error?: string };
export type WriteAppearanceResult = { ok: true; path: string } | { ok: false; path: string; error: string };

const BASENAME = "terrific.json";
const STALE_LOCK_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function parseSection(value: unknown): AppearanceConfig | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.enabled !== "boolean" || (value.settingsLanguage !== "en" && value.settingsLanguage !== "zh")
    || typeof value.header !== "boolean" || typeof value.editor !== "boolean") return undefined;
  return {
    enabled: value.enabled,
    settingsLanguage: value.settingsLanguage,
    header: value.header,
    editor: value.editor,
  };
}

export function resolveAppearanceConfigPath(agentDir: string): string {
  return join(agentDir, BASENAME);
}

export function loadAppearanceConfig(agentDir: string): LoadAppearanceResult {
  const path = resolveAppearanceConfigPath(agentDir);
  if (!existsSync(path)) return { config: undefined };
  try {
    const root: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(root)) return { error: `${BASENAME} root must be an object` };
    if (!("appearance" in root)) return { config: undefined };
    const config = parseSection(root.appearance);
    return config ? { config } : { error: "appearance section is malformed" };
  } catch (error) {
    return { error: `Failed to parse ${BASENAME}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

type ConfigLock = { ok: true; path: string; token: string } | { ok: false; error: string };

function lockOwnerIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function isRecoverableLock(path: string): boolean {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isRecord(value) && typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0) {
      return !lockOwnerIsAlive(value.pid);
    }
  } catch {
    // Legacy empty locks are recoverable after they age out.
  }
  try {
    return Date.now() - statSync(path).mtimeMs >= STALE_LOCK_MS;
  } catch {
    return false;
  }
}

function acquireLock(path: string): ConfigLock {
  const lockPath = `${path}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = randomUUID();
    let created = false;
    try {
      const descriptor = openSync(lockPath, "wx", 0o600);
      created = true;
      try {
        writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: Date.now(), token }), "utf8");
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      return { ok: true, path: lockPath, token };
    } catch (error) {
      if (created) {
        try { unlinkSync(lockPath); } catch { /* ignore */ }
      }
      if (errorCode(error) === "EEXIST" && attempt === 0 && isRecoverableLock(lockPath)) {
        try { unlinkSync(lockPath); continue; } catch { /* report below */ }
      }
      return errorCode(error) === "EEXIST"
        ? { ok: false, error: `${BASENAME} is locked (${lockPath}); retry after other writers finish` }
        : { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { ok: false, error: `${BASENAME} is locked (${lockPath})` };
}

function releaseLock(lock: Extract<ConfigLock, { ok: true }>): void {
  try {
    const value: unknown = JSON.parse(readFileSync(lock.path, "utf8"));
    if (isRecord(value) && value.token === lock.token) unlinkSync(lock.path);
  } catch {
    // A completed write remains valid if lock cleanup is interrupted.
  }
}

export function writeAppearanceSection(config: AppearanceConfig, agentDir: string): WriteAppearanceResult {
  const path = resolveAppearanceConfigPath(agentDir);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  } catch (error) {
    return { ok: false, path, error: `Cannot create agent dir: ${error instanceof Error ? error.message : String(error)}` };
  }
  const lock = acquireLock(path);
  if (!lock.ok) return { ok: false, path, error: lock.error };
  try {
    let root: Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (!isRecord(parsed)) return { ok: false, path, error: `${BASENAME} root is not an object` };
        root = parsed;
      } catch (error) {
        return { ok: false, path, error: `Failed to parse ${BASENAME}: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    root.appearance = { ...config };
    const temporary = join(dirname(path), `.terrific.${process.pid}.${randomUUID()}.tmp`);
    const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
    try {
      const descriptor = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(descriptor, `${JSON.stringify(root, null, 2)}\n`, "utf8");
        chmodSync(temporary, mode);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporary, path);
      return { ok: true, path };
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* ignore */ }
      return { ok: false, path, error: error instanceof Error ? error.message : String(error) };
    }
  } finally {
    releaseLock(lock);
  }
}
