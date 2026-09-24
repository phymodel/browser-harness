// Resolve `playwright` without forcing a local node_modules:
//   1. $BH_PLAYWRIGHT (dir or entry file)
//   2. local development install (`npm i playwright` inside the harness)
//   3. global npm roots (npm root -g, then common Homebrew/system paths)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type PwInfo = {
  source: string;
  version: string;
  executablePath: string | null;
};

let moduleCache: any = null;
let infoCache: PwInfo | null = null;

const COMMON_GLOBAL_ROOTS = [
  '/opt/homebrew/lib/node_modules',
  '/usr/local/lib/node_modules',
  '/usr/lib/node_modules',
  path.join(process.env.HOME || '', '.npm-global', 'lib', 'node_modules'),
];

function entryOf(dir: string): string | null {
  for (const f of ['index.mjs', 'index.js', 'index.cjs']) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function globalRoots(): string[] {
  const roots: string[] = [];
  try {
    const out = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (out.trim()) roots.push(out.trim());
  } catch {
    /* npm may be missing — fall through to the well-known paths */
  }
  roots.push(...COMMON_GLOBAL_ROOTS);
  return roots.filter(Boolean);
}

function candidates(): string[] {
  const list: string[] = [];
  if (process.env.BH_PLAYWRIGHT) list.push(process.env.BH_PLAYWRIGHT);
  const local = path.join(process.env.BH_ROOT || '', 'node_modules', 'playwright');
  if (process.env.BH_ROOT) list.push(local);
  for (const root of globalRoots()) list.push(path.join(root, 'playwright'));
  return list;
}

const SETUP_HINT =
  'playwright not found. Install it once:\n' +
  '  npm i -g playwright && playwright install chromium\n' +
  'or point BH_PLAYWRIGHT at an existing install dir.';

export async function getPlaywright(): Promise<any> {
  if (moduleCache) return moduleCache;

  // 1) plain resolution (local node_modules or NODE_PATH)
  try {
    const mod = await import('playwright');
    moduleCache = mod.chromium ? mod : (mod.default ?? mod);
    if (moduleCache?.chromium) return moduleCache;
  } catch {
    /* keep trying */
  }

  // 2) explicit candidate dirs -> entry file
  for (const candidate of candidates()) {
    let entry: string | null = null;
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) entry = entryOf(candidate);
      else if (candidate.endsWith('.mjs') || candidate.endsWith('.js') || candidate.endsWith('.cjs')) entry = candidate;
    } catch {
      entry = null;
    }
    if (!entry) continue;
    try {
      const mod = await import(pathToFileURL(entry).href);
      const resolved = mod.chromium ? mod : (mod.default ?? mod);
      if (resolved?.chromium) {
        moduleCache = resolved;
        return moduleCache;
      }
    } catch {
      /* try next candidate */
    }
  }

  const err = new Error(SETUP_HINT) as Error & { code?: string };
  err.code = 'E_NO_PLAYWRIGHT';
  throw err;
}

export async function getChromium(): Promise<any> {
  const mod = await getPlaywright();
  const chromium = mod?.chromium ?? mod?.default?.chromium;
  if (!chromium) {
    const err = new Error('loaded the playwright module but it exposes no `chromium` export') as Error & { code?: string };
    err.code = 'E_NO_CHROMIUM';
    throw err;
  }
  return chromium;
}

/** Diagnostics for `browserctl doctor` — never throws. */
export async function describePlaywright(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  try {
    const chromium = await getChromium();
    const executablePath = chromium.executablePath();
    out.playwrightOk = true;
    out.chromiumExecutable = executablePath;
    out.chromiumInstalled = Boolean(executablePath && fs.existsSync(executablePath));
    try {
      const pkg = require_pkg();
      out.playwrightVersion = pkg;
    } catch {
      /* ignore */
    }
  } catch (e) {
    out.playwrightOk = false;
    out.error = (e as Error).message;
  }
  return out;
}

function require_pkg(): string | null {
  for (const root of globalRoots()) {
    const p = path.join(root, 'playwright', 'package.json');
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8')).version as string;
    } catch {
      /* next */
    }
  }
  return null;
}
