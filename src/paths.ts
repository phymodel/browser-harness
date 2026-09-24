// Path + small fs helpers. Everything is relative to the harness root so the
// package stays portable (Studio syncs it / clones it anywhere).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '0.1.0';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

export function harnessRoot(): string {
  return path.resolve(process.env.BH_ROOT || path.join(SRC_DIR, '..'));
}

/** Runtime state: daemon.json, token, logs, screenshots, downloads. */
export function stateDir(): string {
  return path.resolve(process.env.BH_STATE_DIR || path.join(harnessRoot(), '.state'));
}

/** Dedicated Chromium user-data-dir — the built-in browser never touches the device browser. */
export function profileDir(): string {
  return path.resolve(process.env.BH_PROFILE_DIR || path.join(harnessRoot(), '.profile', 'chromium'));
}

export function daemonInfoPath(): string {
  return path.join(stateDir(), 'daemon.json');
}
export function daemonLogPath(): string {
  return path.join(stateDir(), 'daemon.log');
}
export function shotsDir(): string {
  return path.join(stateDir(), 'shots');
}
export function downloadsDir(): string {
  return path.join(stateDir(), 'downloads');
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function ensureDirs(): void {
  ensureDir(stateDir());
  ensureDir(shotsDir());
  ensureDir(downloadsDir());
  ensureDir(profileDir());
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file: string, value: unknown, mode = 0o600): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
  fs.renameSync(tmp, file);
}

export function removeQuietly(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

export function appendLine(file: string, line: string): void {
  try {
    ensureDir(path.dirname(file));
    fs.appendFileSync(file, `${line}\n`);
  } catch {
    /* logging must never break the harness */
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function truncate(s: unknown, max: number): string {
  const str = typeof s === 'string' ? s : String(s ?? '');
  return str.length <= max ? str : `${str.slice(0, max)}…(+${str.length - max} chars)`;
}
