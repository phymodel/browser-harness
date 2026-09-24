// BrowserSession — owns the built-in Chromium window and implements every
// command. Perception is accessibility-tree first (Playwright's AI aria
// snapshot with stable `[ref=eN]` handles); screenshots are on-demand only.
import fs from 'node:fs';
import path from 'node:path';
import { getChromium } from './pw.ts';
import * as P from './paths.ts';
import { log } from './log.ts';

export type BhError = Error & { code?: string; hint?: string };

export function fail(message: string, hint?: string, code = 'E_BH'): never {
  const e = new Error(message) as BhError;
  e.code = code;
  e.hint = hint;
  throw e;
}

const RING_MAX = Number(process.env.BH_RING_MAX || 400);
const ACTION_TIMEOUT = Number(process.env.BH_TIMEOUT_MS || 15000);
const NAV_TIMEOUT = Number(process.env.BH_NAV_TIMEOUT_MS || 45000);
const MAX_LINES = Number(process.env.BH_MAX_LINES || 1500);
const MAX_TEXT = Number(process.env.BH_MAX_TEXT || 20000);
const MAX_JSON = Number(process.env.BH_MAX_JSON || 40000);

const SKIP_REQUEST_TYPES = new Set(['image', 'font', 'stylesheet', 'script', 'media', 'other']);

const SCREENSHOT_NOTE =
  'saved to disk — the agent cannot see pixels; use snapshot/text for reasoning, this file is for human verification';

function flag(name: string, dflt = false): boolean {
  const v = process.env[name];
  if (v === undefined) return dflt;
  return !['0', 'false', 'no', 'off', ''].includes(v.toLowerCase());
}

function num(v: unknown, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

/** Minimal PNG header reader so we can report the real image size. */
function pngSize(file: string): { width: number; height: number } | null {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(24);
    fs.readSync(fd, buf, 0, 24, 0);
    fs.closeSync(fd);
    if (buf.toString('ascii', 1, 4) !== 'PNG') return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch {
    return null;
  }
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Keep lines matching `query` plus their ancestor lines, so the tree stays readable. */
function filterTree(lines: string[], query: string): string[] {
  const q = query.toLowerCase();
  const keep = new Set<number>();
  lines.forEach((line, i) => {
    if (!line.toLowerCase().includes(q)) return;
    keep.add(i);
    let indent = indentOf(line);
    for (let j = i - 1; j >= 0 && indent > 0; j--) {
      const ind = indentOf(lines[j]);
      if (ind < indent) {
        keep.add(j);
        indent = ind;
      }
    }
  });
  return lines.filter((_, i) => keep.has(i));
}

type Slot = {
  ref: string | null;
  role: string | null;
  name: string | null;
  text: string | null;
  depth: number;
};

function walkTree(nodes: any, visit: (node: any, depth: number) => void, depth = 0): void {
  const list = Array.isArray(nodes) ? nodes : [nodes];
  for (const node of list) {
    if (!node || typeof node !== 'object') continue;
    visit(node, depth);
    if (node.children) walkTree(node.children, visit, depth + 1);
  }
}

function toSlots(nodes: any, out: Slot[] = [], depth = 0): Slot[] {
  walkTree(
    nodes,
    (node, d) => {
      out.push({
        ref: typeof node.ref === 'string' ? node.ref : null,
        role: typeof node.role === 'string' ? node.role : null,
        name: typeof node.name === 'string' ? node.name : null,
        text: typeof node.text === 'string' ? P.truncate(node.text, 200) : null,
        depth: d,
      });
    },
    depth,
  );
  return out;
}

function jsonSafe(value: unknown, maxChars = MAX_JSON): unknown {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return String(value);
  }
  if (text === undefined) return null;
  if (text.length <= maxChars) {
    return value === undefined ? null : JSON.parse(text);
  }
  return { truncated: true, chars: text.length, preview: `${text.slice(0, maxChars)}…` };
}

/**
 * Turn user code into a page expression.
 *  - `() => document.title` / `function () {…}`  -> call it (and await the result)
 *  - `return …`                                  -> treat as a function body
 *  - anything else                               -> run as a script, hand back the
 *    completion value (so `const a = 1; a` and `document.title` both work)
 */
function buildEvalSource(raw: string): string {
  const code = raw.trim();
  if (/^(async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(code) || /^(async\s+)?function\b/.test(code)) {
    return `(async () => { const __f = (${code}); return await (typeof __f === 'function' ? __f() : __f); })()`;
  }
  if (/^return\b/.test(code)) return `(async () => { ${code} })()`;
  return `(async () => { const __v = (0, eval)(${JSON.stringify(code)}); return await __v; })()`;
}

export type SessionOptions = {
  headless?: boolean;
  windowSize?: string;
  idleTimeoutMs?: number;
};

export class BrowserSession {
  context: any = null;
  startedAt = Date.now();
  snapshotCount = 0;
  actionCount = 0;
  logs: any[] = [];
  requests: any[] = [];
  downloads: any[] = [];
  headless = false;
  windowSize = process.env.BH_WINDOW_SIZE || '1400x900';
  idleTimeoutMs = 0;
  idleTimer: any = null;
  closing = false;
  lastError: string | null = null;
  private chromium: any = null;

  constructor(opts: SessionOptions = {}) {
    this.headless = opts.headless ?? flag('BH_HEADLESS');
    if (opts.windowSize) this.windowSize = opts.windowSize;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? num(process.env.BH_IDLE_TIMEOUT_MS, 0);
  }

  // ---------------------------------------------------------------- lifecycle

  async launch(url?: string): Promise<void> {
    P.ensureDirs();
    this.chromium ||= await getChromium();
    const args = [
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-crash-restore-bubble',
      '--disable-background-timer-throttling',
      '--disable-features=Translate,MediaRouter,OptimizationHints',
    ];
    if (process.env.BH_EXTRA_ARGS) args.push(...process.env.BH_EXTRA_ARGS.split(' ').filter(Boolean));
    if (!this.headless) {
      args.push(`--window-size=${this.windowSize.replace('x', ',')}`);
      if (process.env.BH_WINDOW_POSITION) args.push(`--window-position=${process.env.BH_WINDOW_POSITION.replace('+', ',')}`);
    }

    // A dedicated user-data-dir => a truly built-in browser: nothing of the
    // device's own browser/profile is touched, and no OS permission is needed.
    this.context = await this.chromium.launchPersistentContext(P.profileDir(), {
      headless: this.headless,
      viewport: null,
      args,
      acceptDownloads: true,
      downloadsPath: P.downloadsDir(),
      ignoreHTTPSErrors: flag('BH_IGNORE_HTTPS_ERRORS'),
      timeout: 60000,
    });
    this.context.setDefaultTimeout(ACTION_TIMEOUT);
    this.context.setDefaultNavigationTimeout(NAV_TIMEOUT);
    this.context.on('page', (page: any) => this.wirePage(page));
    for (const page of this.context.pages()) this.wirePage(page);
    if (this.context.pages().length === 0) await this.context.newPage();
    await this.activePage();
    log(`browser launched headless=${this.headless} profile=${P.profileDir()}`);
    if (url) await this.cmdGoto({ url });
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    try {
      await this.context?.close();
    } catch {
      /* already gone */
    }
    this.context = null;
  }

  private async ensureAlive(): Promise<void> {
    if (this.closing) fail('daemon is shutting down', undefined, 'E_CLOSING');
    if (!this.context) {
      log('browser window was closed — relaunching');
      await this.launch();
    }
  }

  private wirePage(page: any): void {
    const indexOf = () => this.context?.pages().indexOf(page) ?? -1;

    page.on('console', (msg: any) => {
      this.push(this.logs, {
        t: Date.now(),
        kind: 'console',
        level: msg.type(),
        page: indexOf(),
        text: P.truncate(msg.text(), 600),
      });
    });
    page.on('pageerror', (err: any) => {
      this.push(this.logs, {
        t: Date.now(),
        kind: 'pageerror',
        level: 'error',
        page: indexOf(),
        text: P.truncate(err?.message ?? String(err), 900),
      });
    });
    page.on('dialog', async (dialog: any) => {
      const policy = (process.env.BH_DIALOG_ACTION || 'dismiss').toLowerCase();
      this.push(this.logs, {
        t: Date.now(),
        kind: 'dialog',
        level: 'warn',
        page: indexOf(),
        text: `[${dialog.type()}] ${dialog.message()}`,
        action: policy,
      });
      try {
        if (policy === 'accept') await dialog.accept();
        else await dialog.dismiss();
      } catch {
        /* the page may have closed the dialog already */
      }
    });
    page.on('download', async (download: any) => {
      try {
        const file = path.join(P.downloadsDir(), `${stamp()}-${download.suggestedFilename()}`);
        await download.saveAs(file);
        this.downloads.push({ t: Date.now(), file, bytes: fs.statSync(file).size });
        this.push(this.logs, { t: Date.now(), kind: 'download', level: 'info', page: indexOf(), text: file });
      } catch (e) {
        this.push(this.logs, {
          t: Date.now(),
          kind: 'download',
          level: 'error',
          page: indexOf(),
          text: `download failed: ${(e as Error).message}`,
        });
      }
    });
    page.on('requestfailed', (req: any) => {
      this.push(this.requests, {
        t: Date.now(),
        ok: false,
        method: req.method(),
        type: req.resourceType(),
        url: P.truncate(req.url(), 300),
        error: req.failure()?.errorText ?? 'failed',
      });
    });
    page.on('response', (res: any) => {
      const type = res.request().resourceType();
      const status = res.status();
      if (SKIP_REQUEST_TYPES.has(type) && status < 400 && !flag('BH_LOG_ALL_REQUESTS')) return;
      this.push(this.requests, {
        t: Date.now(),
        ok: status < 400,
        status,
        method: res.request().method(),
        type,
        url: P.truncate(res.url(), 300),
      });
    });
  }

  private push(ring: any[], entry: any): void {
    ring.push(entry);
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  }

  // ------------------------------------------------------------------ helpers

  async activePage(): Promise<any> {
    await this.ensureAlive();
    const pages = this.context.pages().filter((p: any) => !p.isClosed());
    if (!pages.length) return this.context.newPage();
    return pages[pages.length - 1];
  }

  /**
   * `e12` / `ref=e12` / `[ref=e12]` / `@e12` => a11y ref from the last snapshot.
   * `f1e2` works too: refs inside an <iframe> carry a frame prefix.
   * Anything else is passed to Playwright as a selector (css, #id, .class, text=…, xpath=…).
   */
  async resolve(target: unknown, page?: any): Promise<any> {
    if (target === undefined || target === null || target === '') fail('missing element target');
    const pageOrActive = page ?? (await this.activePage());
    const raw = String(target).trim();
    // accepts: e12 | ref=e12 | [ref=e12] | @e12 | f1e2 (iframe-prefixed)
    const m = /^(?:ref=)?@?\(?\[?((?:[a-z]\d+)?e\d+)\]?\)?$/i.exec(raw);
    if (m && !raw.startsWith('#')) {
      const ref = m[1];
      const locator = pageOrActive.locator(`aria-ref=${ref}`);
      let count = 0;
      try {
        count = await locator.count();
      } catch {
        count = 0;
      }
      if (!count) {
        fail(
          `stale ref "${ref}": no element matches it anymore`,
          'the page changed or navigated — run `browserctl snapshot` and use a fresh [ref=eN]',
          'E_STALE_REF',
        );
      }
      return { locator, kind: 'ref', ref, raw, page: pageOrActive };
    }
    // Anything Playwright understands: css, #id, .class, text=…, xpath=…, //xpath
    return { locator: pageOrActive.locator(raw), kind: 'selector', ref: null, raw, page: pageOrActive };
  }

  private async guard<T>(fn: () => Promise<T>, target?: any): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const msg = (e as Error).message.split('\n')[0];
      this.lastError = msg;
      let size = '';
      if (target?.locator) {
        try {
          const n = await target.locator.count();
          size = n === 0 ? ' — no element currently matches this target' : ` — ${n} element(s) currently match`;
        } catch {
          size = '';
        }
      }
      const who = target ? `target ${JSON.stringify(target.raw)} (${target.kind})` : '';
      if (target?.kind === 'ref') {
        fail(`${who}: ${msg}${size}`, 'run `browserctl snapshot` and use a fresh ref', 'E_ACTION_REF');
      }
      fail(
        `${who ? `${who}: ` : ''}${msg}${size}`,
        'check the target, or run `browserctl snapshot` to inspect the page',
        'E_ACTION',
      );
    }
  }

  private async pageState(page?: any): Promise<Record<string, unknown>> {
    const p = page ?? (await this.activePage());
    const pages = this.context?.pages() ?? [];
    const vp = p.viewportSize?.() ?? null;
    let dom = { x: 0, y: 0, max: 0, w: 0, h: 0, visibility: null as string | null };
    try {
      dom = await p.evaluate(() => ({
        x: Math.round(window.scrollX),
        y: Math.round(window.scrollY),
        max: Math.round(Math.max(0, (document.documentElement?.scrollHeight ?? 0) - window.innerHeight)),
        w: window.innerWidth,
        h: window.innerHeight,
        visibility: document.visibilityState,
      }));
    } catch {
      /* about:blank / detached frame */
    }
    const size = vp ? `${vp.width}x${vp.height}` : dom.w ? `${dom.w}x${dom.h}` : null;
    return {
      url: p.url(),
      title: await p.title().catch(() => null),
      tab: pages.indexOf(p) + 1,
      tabs: pages.length,
      viewport: size,
      scroll: `${dom.y}/${dom.max}`,
      hidden: dom.visibility === 'hidden' || undefined,
      snap: this.snapshotCount,
    };
  }

  private normalizeUrl(input: string): string {
    const url = String(input).trim();
    if (!url) fail('goto needs a url');
    if (/^(https?|file|data|about|chrome|view-source|blob):/i.test(url)) return url;
    if (url.startsWith('//')) return `https:${url}`;
    if (/^localhost(:\d+)?(\/|$)/.test(url) || /^\d+\.\d+\.\d+\.\d+(:\d+)?/.test(url)) return `http://${url}`;
    return `https://${url}`;
  }

  // ------------------------------------------------------------------- status

  async cmdStatus(): Promise<Record<string, unknown>> {
    const pages = this.context?.pages() ?? [];
    const active = pages.length ? pages[pages.length - 1] : null;
    return {
      running: Boolean(this.context),
      pid: process.pid,
      uptimeMs: Date.now() - this.startedAt,
      headless: this.headless,
      windowSize: this.windowSize,
      harnessRoot: P.harnessRoot(),
      profile: P.profileDir(),
      stateDir: P.stateDir(),
      downloadsDir: P.downloadsDir(),
      pages: pages.length,
      url: active ? active.url() : null,
      title: active && this.context ? await active.title().catch(() => null) : null,
      snapshots: this.snapshotCount,
      actions: this.actionCount,
      logs: this.logs.length,
      requests: this.requests.length,
      downloads: this.downloads.length,
      lastError: this.lastError,
    };
  }

  // ---------------------------------------------------------------- navigation

  async cmdGoto(a: any): Promise<Record<string, unknown>> {
    const url = this.normalizeUrl(a.url);
    const page = await this.activePage();
    const t0 = Date.now();
    const res = await this.guard(() =>
      page.goto(url, { timeout: num(a.timeout, NAV_TIMEOUT), waitUntil: a.waitUntil || 'domcontentloaded' }),
    );
    this.actionCount++;
    return {
      action: 'goto',
      url: page.url(),
      title: await page.title().catch(() => null),
      status: res?.status() ?? null,
      ms: Date.now() - t0,
      hint: 'run `browserctl snapshot` for the a11y tree + refs',
    };
  }

  async cmdHistory(a: any): Promise<Record<string, unknown>> {
    const page = await this.activePage();
    const t0 = Date.now();
    const dir = String(a.direction || 'back');
    if (dir === 'back') await this.guard(() => page.goBack({ timeout: num(a.timeout, NAV_TIMEOUT), waitUntil: 'domcontentloaded' }));
    else if (dir === 'forward') await this.guard(() => page.goForward({ timeout: num(a.timeout, NAV_TIMEOUT), waitUntil: 'domcontentloaded' }));
    else await this.guard(() => page.reload({ timeout: num(a.timeout, NAV_TIMEOUT), waitUntil: 'domcontentloaded' }));
    this.actionCount++;
    return { action: dir, url: page.url(), title: await page.title().catch(() => null), ms: Date.now() - t0 };
  }

  async cmdFocus(a: any): Promise<Record<string, unknown>> {
    const page = await this.activePage();
    await page.bringToFront().catch(() => {});
    if (a.target) {
      const t = await this.resolve(a.target, page);
      await this.guard(() => t.locator.focus({ timeout: num(a.timeout, ACTION_TIMEOUT) }), t);
    }
    return { action: 'focus', ...(await this.pageState(page)) };
  }

  // ---------------------------------------------------------------- perception

  async cmdSnapshot(a: any): Promise<Record<string, unknown>> {
    const page = await this.activePage();
    const t0 = Date.now();
    const opts: any = { mode: 'ai' };
    if (a.depth) opts.depth = num(a.depth, 0);
    if (a.boxes) opts.boxes = true;

    let text: string;
    try {
      text = await page.ariaSnapshot(opts);
    } catch (e) {
      fail(`cannot take an accessibility snapshot: ${(e as Error).message.split('\n')[0]}`, undefined, 'E_SNAPSHOT');
    }
    const allLines = text.split('\n').filter((l: string) => l.trim() !== '');
    const tree = filterTree(allLines, a.grep ? String(a.grep) : '');
    const refs = [...text.matchAll(/\[ref=([a-z0-9]+)\]/g)].map((m) => m[1]);
    const maxLines = num(a.maxLines, MAX_LINES);
    const truncated = tree.length > maxLines;
    const shown = truncated ? tree.slice(0, maxLines) : tree;
    this.snapshotCount++;
    const state = await this.pageState(page);

    const header =
      `[PAGE] title=${JSON.stringify(state.title)} url=${state.url} tab=${state.tab}/${state.tabs} ` +
      `viewport=${state.viewport} scroll=${state.scroll} snap=#${this.snapshotCount}`;
    const statsLine =
      `[STATS] lines=${shown.length}/${allLines.length} refs=${refs.length} truncated=${truncated ? 'yes' : 'no'} ${Date.now() - t0}ms` +
      (a.grep ? ` grep=${JSON.stringify(String(a.grep))}` : '');
    const hint =
      '[HINT] act with [ref=eN] (browserctl click e12 / type e4 "text"). Refs are stable within a document; re-snapshot after navigation or when a ref goes stale.';

    if (a.json) {
      let jsonTree: unknown = null;
      try {
        jsonTree = await page.ariaSnapshotJSON({ mode: 'ai' });
      } catch {
        jsonTree = null;
      }
      return {
        page: state,
        stats: { lines: shown.length, totalLines: allLines.length, refs: refs.length, truncated },
        slots: jsonTree ? toSlots(jsonTree) : refs.map((r) => ({ ref: r, role: null, name: null, text: null, depth: 0 })),
        json: jsonTree,
        text: `${header}\n[TREE]\n${shown.join('\n')}\n${statsLine}`,
      };
    }

    const body = [
      header,
      '[TREE]',
      shown.join('\n'),
      truncated ? `… (${tree.length - shown.length} more lines truncated; use --grep/--depth/--max-lines)` : '',
      statsLine,
      hint,
    ]
      .filter((l) => l !== '')
      .join('\n');

    return { page: state, stats: { lines: shown.length, refs: refs.length, truncated }, text: body };
  }

  async cmdFind(a: any): Promise<Record<string, unknown>> {
    const query = String(a.query ?? '').trim();
    if (!query) fail('find needs a query string', 'example: browserctl find 登录');
    const page = await this.activePage();
    let tree: any;
    try {
      tree = await page.ariaSnapshotJSON({ mode: 'ai' });
    } catch (e) {
      fail(`cannot read the a11y tree: ${(e as Error).message.split('\n')[0]}`, undefined, 'E_SNAPSHOT');
    }
    const q = query.toLowerCase();
    const matches: any[] = [];
    walkTree(tree, (node, depth) => {
      const hay = [node.role, node.name, typeof node.text === 'string' ? node.text : '']
        .filter((v) => typeof v === 'string')
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return;
      matches.push({
        ref: node.ref ?? null,
        role: node.role ?? null,
        name: node.name ?? null,
        text: typeof node.text === 'string' ? P.truncate(node.text, 120) : null,
        depth,
      });
    });
    const limit = num(a.limit, 30);
    return { query, count: matches.length, matches: matches.slice(0, limit), truncated: matches.length > limit };
  }

  async cmdText(a: any): Promise<Record<string, unknown>> {
    const page = await this.activePage();
    const target = a.target ? await this.resolve(a.target, page) : null;
    const locator = target ? target.locator : page.locator('body');
    const raw = await this.guard(() => locator.innerText({ timeout: num(a.timeout, ACTION_TIMEOUT) }), target);
    const text = String(raw).replace(/\n{3,}/g, '\n\n').trim();
    const max = num(a.maxChars, MAX_TEXT);
    return {
      action: 'text',
      target: a.target ?? 'body',
      chars: text.length,
      truncated: text.length > max,
      text: text.length > max ? `${text.slice(0, max)}…` : text,
    };
  }

  async cmdHtml(a: any): Promise<Record<string, unknown>> {
    const page = await this.activePage();
    const target = await this.resolve(a.target ?? 'body', page);
    const raw = await this.guard(() => target.locator.innerHTML({ timeout: num(a.timeout, ACTION_TIMEOUT) }), target);
    const max = num(a.maxChars, MAX_TEXT);
    return {
      action: 'html',
      target: a.target ?? 'body',
      chars: String(raw).length,
      truncated: String(raw).length > max,
      html: String(raw).length > max ? `${String(raw).slice(0, max)}…` : raw,
    };
  }

  async cmdScreenshot(a: any): Promise<Record<string, unknown>> {
    const page = await this.activePage();
    await page.bringToFront().catch(() => {});
    const t0 = Date.now();
    const out = a.out ? path.resolve(String(a.out)) : path.join(P.shotsDir(), `shot-${stamp()}.png`);
    P.ensureDir(path.dirname(out));
    const target = a.target ? await this.resolve(a.target, page) : null;
    const shotTarget = target ? target.locator : page;
    await this.guard(
      () => shotTarget.screenshot({ path: out, fullPage: Boolean(a.full), timeout: num(a.timeout, ACTION_TIMEOUT) }),
      target ?? undefined,
    );
    const size = pngSize(out);
    const bytes = fs.existsSync(out) ? fs.statSync(out).size : 0;
    return {
      action: 'screenshot',
      path: out,
      width: size?.width ?? null,
      height: size?.height ?? null,
      bytes,
      fullPage: Boolean(a.full),
      ms: Date.now() - t0,
      note: SCREENSHOT_NOTE,
    };
  }

  // ------------------------------------------------------------------ actions

  async cmdClick(a: any): Promise<Record<string, unknown>> {
    const page = await this.activePage();
    const t = await this.resolve(a.target, page);
    const t0 = Date.now();
    const button = a.button || 'left';
    const count = num(a.count, 1);
    await this.guard(
      () => t.locator.click({ timeout: num(a.timeout, ACTION_TIMEOUT), button, clickCount: count, force: Boolean(a.force) }),
      t,
    );
    this.actionCount++;
    return {
      action: count > 1 ? 'click x' + count : 'click',
      target: a.target,
      kind: t.kind,
      ref: t.ref,
      button,
      ms: Date.now() - t0,
      ...(await this.pageState(page)),
    };
  }

  async cmdHover(a: any): Promise<Record<string, unknown>> {
    const page = await this.activePage();
    const t = await this.resolve(a.target, page);
    const t0 = Date.now();
    await this.guard(() => t.locator.hover({ timeout: num(a.timeout, ACTION_TIMEOUT) }), t);
    this.actionCount++;
    return { action: 'hover', target: a.target, ref: t.ref, ms: Date.now() - t0, ...(await this.pageState(page)) };
  }

  /** Real keystroke typing (clear → type); good for autocomplete / React inputs. */
  async cmdType(a: any): Promise<Record<string, unknown>> {
    const page = await this.activePage();
    const text = String(a.text ?? '');
    const t = await this.resolve(a.target, page);
    const t0 = Date.now();
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await this.guard(async () => {
      await t.locator.click({ timeout: num(a.timeout, ACTION_TIMEOUT) });
      if (a.clear !== false) {
        await page.keyboard.press(`${mod}+a`);
        await page.keyboard.press('Delete');
      }
      await page.keyboard.type(text, { delay: a.slow ? 50 : 0 });
      if (a.submit) await page.keyboard.press('Enter');
    }, t);
    this.actionCount++;
    return {
      action: 'type',
      target: a.target,
      ref: t.ref,
      chars: text.length,
      submitted: Boolean(a.submit),
      ms: Date.now() - t0,
      ...(await this.pageState(page)),
    };
  }

  /** Fast value set (no keystroke events). */
  async cmdFill(a: any): Promise<Record<string, unknown>> {
    const page = await this.activePage();
    const t = await this.resolve(a.target, page);
    const text = String(a.text ?? '');
    const t0 = Date.now();
    await this.guard(async () => {
      await t.locator.fill(text, { timeout: num(a.timeout, ACTION_TIMEOUT) });
      if (a.submit) await page.keyboard.press('Enter');
    }, t);
    this.actionCount++;
    return {
      action: 'fill',
      target: a.target,
      ref: t.ref,
      chars: text.length,
      submitted: Boolean(a.submit),
      ms: Date.now() - t0,
      ...(await this.pageState(page)),
    };
  }

  async cmdPress(a: any): Promise<Record<string, unknown>> {
    const page = await this.activePage();
    const t0 = Date.now();
    const key = String(a.key || 'Enter');
    if (a.target) {
      const t = await this.resolve(a.target, page);
      await this.guard(() => t.locator.press(key, { timeout: num(a.timeout, ACTION_TIMEOUT) }), t);
    } else {
      await this.guard(() => page.keyboard.press(key));
    }
    this.actionCount++;
    return { action: 'press', key, target: a.target ?? null, ms: Date.now() - t0, ...(await this.pageState(page)) };
  }

  async cmdSelect(a: any): Promise<Record<string, unknown>> {
    const page = await this.activePage();
    const t = await this.resolve(a.target, page);
    const values = Array.isArray(a.values) ? a.values : [a.value];
    const picked = await this.guard(
      () => t.locator.selectOption(values as any, { timeout: num(a.timeout, ACTION_TIMEOUT) }),
      t,
    );
    this.actionCount++;
    return { action: 'select', target: a.target, ref: t.ref, selected: picked, ...(await this.pageState(page)) };
  }

  async cmdToggle(a: any): Promise<Record<string, unknown>> {
    const page = await this.activePage();
    const t = await this.resolve(a.target, page);
    const want = a.action === 'uncheck' ? false : a.action === 'check' ? true : null;
    await this.guard(async () => {
      if (want === null) await t.locator.click({ timeout: num(a.timeout, ACTION_TIMEOUT) });
      else await t.locator.setChecked(want, { timeout: num(a.timeout, ACTION_TIMEOUT) });
    }, t);
    this.actionCount++;
    return { action: a.action, target: a.target, ref: t.ref, ...(await this.pageState(page)) };
  }

  async cmdUpload(a: any): Promise<Record<string, unknown>> {
    const page = await this.activePage();
    const t = await this.resolve(a.target, page);
    const files = (Array.isArray(a.files) ? a.files : [a.files]).filter(Boolean).map((f: string) => path.resolve(f));
    for (const f of files) if (!fs.existsSync(f)) fail(`file not found: ${f}`);
    await this.guard(() => t.locator.setInputFiles(files as any, { timeout: num(a.timeout, ACTION_TIMEOUT) }), t);
    this.actionCount++;
    return { action: 'upload', target: a.target, ref: t.ref, files, ...(await this.pageState(page)) };
  }

  async cmdScroll(a: any): Promise<Record<string, unknown>> {
    const page = await this.activePage();
    const dir = String(a.direction || 'down').toLowerCase();
    const amount = num(a.amount, 600);
    const t0 = Date.now();
    if (a.target) {
      const t = await this.resolve(a.target, page);
      await this.guard(() => t.locator.scrollIntoViewIfNeeded({ timeout: num(a.timeout, ACTION_TIMEOUT) }), t);
    } else {
      const vp = page.viewportSize() ?? { width: 1200, height: 800 };
      await page.mouse.move(vp.width / 2, vp.height / 2).catch(() => {});
      if (dir === 'top') await page.evaluate(() => window.scrollTo(0, 0));
      else if (dir === 'bottom') await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      else if (dir === 'up') await page.mouse.wheel(0, -amount);
      else if (dir === 'down') await page.mouse.wheel(0, amount);
      else if (dir === 'left') await page.mouse.wheel(-amount, 0);
      else if (dir === 'right') await page.mouse.wheel(amount, 0);
      else fail(`unknown scroll direction "${dir}"`, 'use up|down|left|right|top|bottom');
    }
    this.actionCount++;
    return { action: 'scroll', direction: a.target ? 'into-view' : dir, target: a.target ?? null, ms: Date.now() - t0, ...(await this.pageState(page)) };
  }

  async cmdWait(a: any): Promise<Record<string, unknown>> {
    const page = await this.activePage();
    const timeout = num(a.timeout, ACTION_TIMEOUT);
    const t0 = Date.now();
    if (a.ms !== undefined) {
      await new Promise((r) => setTimeout(r, num(a.ms, 500)));
      return { action: 'wait', for: `${a.ms}ms`, ms: Date.now() - t0 };
    }
    if (a.text) {
      await this.guard(
        () => page.waitForFunction((t: string) => Boolean(document.body?.innerText?.includes(t)), String(a.text), { timeout }),
      );
      return { action: 'wait', for: `text "${a.text}"`, ms: Date.now() - t0 };
    }
    const sel = a.selector;
    if (sel) {
      await this.guard(() => page.waitForSelector(String(sel), { timeout, state: a.state || 'visible' }));
      return { action: 'wait', for: `selector ${sel}`, ms: Date.now() - t0 };
    }
    const loadState = a.loadState || 'networkidle';
    await page.waitForLoadState(loadState, { timeout }).catch(() => {});
    return { action: 'wait', for: loadState, ms: Date.now() - t0, ...(await this.pageState(page)) };
  }

  async cmdEval(a: any): Promise<Record<string, unknown>> {
    const page = await this.activePage();
    const raw = String(a.code ?? '').trim();
    if (!raw) fail('eval needs code', 'example: browserctl eval "document.title"');
    const value = await this.guard(() => page.evaluate(buildEvalSource(raw)));
    this.actionCount++;
    return { action: 'eval', value: jsonSafe(value), undefined: value === undefined, ...(await this.pageState(page)) };
  }

  // -------------------------------------------------------------- window/tabs

  async cmdWindow(a: any): Promise<Record<string, unknown>> {
    const page = await this.activePage();
    const cdp = await this.context.newCDPSession(page);
    try {
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      if (a.set) {
        const bounds: any = {};
        for (const k of ['left', 'top', 'width', 'height']) if (a[k] !== undefined) bounds[k] = num(a[k], 0);
        if (a.state) bounds.windowState = String(a.state);
        if (!Object.keys(bounds).length) bounds.windowState = 'normal';
        await cdp.send('Browser.setWindowBounds', { windowId, bounds });
      }
      const { bounds } = await cdp.send('Browser.getWindowBounds', { windowId });
      return { action: 'window', windowId, bounds };
    } finally {
      await cdp.detach().catch(() => {});
    }
  }

  async cmdTabs(a: any): Promise<Record<string, unknown>> {
    const pages = this.context?.pages() ?? [];
    const tabs = [];
    for (const [i, p] of pages.entries()) {
      tabs.push({
        index: i + 1,
        url: p.url(),
        title: await p.title().catch(() => null),
        active: i === pages.length - 1,
        closed: p.isClosed(),
      });
    }
    return { action: 'tabs', count: tabs.length, tabs };
  }

  async cmdNewtab(a: any): Promise<Record<string, unknown>> {
    const page = await this.context.newPage();
    this.wirePage(page);
    if (a.url) await this.guard(() => page.goto(this.normalizeUrl(a.url), { timeout: NAV_TIMEOUT, waitUntil: 'domcontentloaded' }));
    await page.bringToFront().catch(() => {});
    return { action: 'newtab', ...(await this.pageState(page)), ...(await this.cmdTabs({})) };
  }

  async cmdSwitchtab(a: any): Promise<Record<string, unknown>> {
    const pages = this.context.pages().filter((p: any) => !p.isClosed());
    const idx = num(a.index, NaN);
    if (!Number.isFinite(idx)) fail('switchtab needs an index', 'see `browserctl tabs` (1-based)');
    const page = pages[idx - 1];
    if (!page) fail(`no tab #${idx}`, `there are ${pages.length} tabs`);
    await page.bringToFront().catch(() => {});
    return { action: 'switchtab', ...(await this.pageState(page)) };
  }

  async cmdClosetab(a: any): Promise<Record<string, unknown>> {
    const pages = this.context.pages().filter((p: any) => !p.isClosed());
    const idx = num(a.index, pages.length);
    const page = pages[idx - 1];
    if (!page) fail(`no tab #${idx}`, `there are ${pages.length} tabs`);
    await page.close();
    const remaining = this.context.pages().filter((p: any) => !p.isClosed());
    if (!remaining.length) await this.context.newPage();
    return { action: 'closetab', closed: idx, ...(await this.cmdTabs({})) };
  }

  // ---------------------------------------------------------------- telemetry

  async cmdLogs(a: any): Promise<Record<string, unknown>> {
    const limit = num(a.limit, 50);
    let items = this.logs;
    if (a.kind) items = items.filter((l) => l.kind === String(a.kind));
    if (a.level) items = items.filter((l) => l.level === String(a.level));
    if (a.errorsOnly) items = items.filter((l) => l.level === 'error' || l.level === 'warn' || l.kind === 'pageerror');
    const slice = items.slice(-limit);
    if (a.clear) this.logs = [];
    return {
      action: 'logs',
      total: items.length,
      returned: slice.length,
      entries: slice.map((l) => `${new Date(l.t).toISOString().slice(11, 19)} [${l.kind}/${l.level}] ${l.text}`),
    };
  }

  async cmdRequests(a: any): Promise<Record<string, unknown>> {
    const limit = num(a.limit, 50);
    let items = this.requests;
    if (a.failedOnly) items = items.filter((r) => !r.ok || r.status >= 400);
    const slice = items.slice(-limit);
    if (a.clear) this.requests = [];
    return {
      action: 'requests',
      total: items.length,
      returned: slice.length,
      entries: slice.map((r) => `${r.method} ${r.status ?? 'FAIL'} ${r.url}${r.error ? ` (${r.error})` : ''}`),
    };
  }

  async cmdDownloads(): Promise<Record<string, unknown>> {
    let files: any[] = [];
    try {
      files = fs
        .readdirSync(P.downloadsDir())
        .map((f) => ({ file: path.join(P.downloadsDir(), f), bytes: fs.statSync(path.join(P.downloadsDir(), f)).size }))
        .sort((x, y) => x.file.localeCompare(y.file));
    } catch {
      files = [];
    }
    return { action: 'downloads', count: files.length, dir: P.downloadsDir(), downloads: files };
  }

  // ----------------------------------------------------------------- dispatch

  async dispatch(cmd: string, args: any): Promise<any> {
    const table: Record<string, (a: any) => Promise<any>> = {
      status: (a) => this.cmdStatus(),
      goto: (a) => this.cmdGoto(a),
      back: () => this.cmdHistory({ direction: 'back' }),
      forward: () => this.cmdHistory({ direction: 'forward' }),
      reload: () => this.cmdHistory({ direction: 'reload' }),
      focus: (a) => this.cmdFocus(a),
      snapshot: (a) => this.cmdSnapshot(a),
      find: (a) => this.cmdFind(a),
      text: (a) => this.cmdText(a),
      html: (a) => this.cmdHtml(a),
      screenshot: (a) => this.cmdScreenshot(a),
      click: (a) => this.cmdClick(a),
      dblclick: (a) => this.cmdClick({ ...a, count: 2 }),
      hover: (a) => this.cmdHover(a),
      type: (a) => this.cmdType(a),
      fill: (a) => this.cmdFill(a),
      press: (a) => this.cmdPress(a),
      select: (a) => this.cmdSelect(a),
      check: (a) => this.cmdToggle({ ...a, action: 'check' }),
      uncheck: (a) => this.cmdToggle({ ...a, action: 'uncheck' }),
      toggle: (a) => this.cmdToggle({ ...a, action: 'toggle' }),
      upload: (a) => this.cmdUpload(a),
      scroll: (a) => this.cmdScroll(a),
      wait: (a) => this.cmdWait(a),
      eval: (a) => this.cmdEval(a),
      window: (a) => this.cmdWindow(a),
      tabs: (a) => this.cmdTabs(a),
      newtab: (a) => this.cmdNewtab(a),
      switchtab: (a) => this.cmdSwitchtab(a),
      closetab: (a) => this.cmdClosetab(a),
      logs: (a) => this.cmdLogs(a),
      requests: (a) => this.cmdRequests(a),
      downloads: () => this.cmdDownloads(),
      shutdown: async () => ({ action: 'shutdown', pid: process.pid }),
    };
    const handler = table[cmd];
    if (!handler) {
      fail(
        `unknown command "${cmd}"`,
        `available: ${Object.keys(table).sort().join(', ')}`,
        'E_UNKNOWN_CMD',
      );
    }
    return handler(args ?? {});
  }
}
