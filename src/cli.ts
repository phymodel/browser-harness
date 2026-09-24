#!/usr/bin/env node
// browserctl — thin CLI client for the browser-harness daemon.
// Every command maps to one JSON-RPC call; the daemon owns the browser window.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as P from './paths.ts';

const HELP = `browserctl ${P.VERSION} — built-in browser window for agents (a11y-tree first, screenshots on demand)

USAGE
  browserctl <command> [args] [flags]

SESSION
  start [url]                 launch the daemon + built-in Chromium window (--restart, --headless,
                              --port=N, --window-size=1400x900, --idle-timeout=SECONDS)
  stop                        close the window and stop the daemon
  restart [url]               stop then start
  status                      daemon / window / page status
  doctor                      environment check (node, playwright, chromium, daemon)
  profile                     where the browser profile, state and screenshots live

PAGE
  goto <url>                  navigate the active tab
  back | forward | reload
  snapshot                    accessibility tree + [ref=eN] handles  <-- main perception call
  find <text>                 find elements by role/name/text -> refs
  text [target]               visible text of the page (or a target)
  html [target]               innerHTML of a target
  wait [sel|text=<s>|ms]      wait for selector / text / milliseconds / load state
  scroll [up|down|left|right|top|bottom] [px]   (or: scroll <target>)
  screenshot [target]         save a PNG to disk (--full, --out=FILE) — for humans, not the model
  eval "<js>"                 run JS in the page

INTERACT (target = ref like e12, or any Playwright selector)
  click <target>              (--count=2, --force, --button=right)
  dblclick <target>
  hover <target>
  type <target> <text...>     real keystrokes: clear -> type (--submit, --slow, --no-clear)
  fill <target> <text...>     fast value set      (--submit)
  press <key> | <target> <key>
  select <target> <value...>
  check <target> | uncheck <target> | toggle <target>
  upload <target> <file...>
  focus [target]              bring the window to the front

TABS
  tabs | newtab [url] | switchtab <n> | closetab <n>     (indices are 1-based)

TELEMETRY
  logs                        console + page errors + dialogs (--limit=N, --errors, --kind=console, --clear)
  requests                    network log (--failed, --limit=N, --clear)
  downloads                   files downloaded into the state dir

FLAGS
  --json                      machine-readable output
  --snapshot                  print a fresh a11y snapshot right after the command
  --timeout=MS                per-action timeout
  --depth=N --boxes --grep=TEXT --max-lines=N     (snapshot shaping)
  --limit=N                   logs/requests/find limit

EXAMPLES
  browserctl start https://example.com
  browserctl snapshot --grep=登录
  browserctl type e4 "alice" --submit --snapshot
  browserctl click e12 && browserctl logs --errors
  browserctl screenshot --full
`;

type Flags = Record<string, string | boolean>;
type Parsed = { cmd: string; pos: string[]; flags: Flags };

function parseArgv(argv: string[]): Parsed {
  const flags: Flags = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined || (next.startsWith('--') && next.length > 2)) flags[body] = true;
        else {
          flags[body] = next;
          i++;
        }
      }
    } else if (a.startsWith('-') && a.length === 2 && a !== '-') {
      flags[a.slice(1)] = true;
    } else {
      pos.push(a);
    }
  }
  const cmd = pos.shift() ?? (flags.help || flags.h ? 'help' : 'status');
  return { cmd, pos, flags };
}

function die(message: string, hint?: string, code = 'E_CLI'): never {
  const payload = { ok: false, error: { code, message, hint } };
  if (globalJson) process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stderr.write(`✗ ${code}: ${message}${hint ? `\n  hint: ${hint}` : ''}\n`);
  process.exit(1);
}

function flagNum(flags: Flags, name: string, dflt?: number): number | undefined {
  const v = flags[name];
  if (v === undefined || v === true) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) die(`--${name} expects a number, got "${v}"`);
  return n;
}

let globalJson = false;

type DaemonInfo = { pid: number; port: number; token?: string; host?: string; profile?: string; stateDir?: string; headless?: boolean };

function readInfo(): DaemonInfo | null {
  const info = P.readJson<DaemonInfo | null>(P.daemonInfoPath(), null);
  if (!info?.port) return null;
  return info;
}

function pidAlive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function probe(timeoutMs = 1000): Promise<{ info: DaemonInfo; health: any } | null> {
  const info = readInfo();
  if (!info) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const health = await res.json();
    if (health?.pid !== info.pid) return null;
    return { info, health };
  } catch {
    return null;
  }
}

async function send(cmd: string, args: any = {}, timeoutMs = 120000): Promise<any> {
  const info = readInfo();
  if (!info) die('the browser daemon is not running', 'run: browserctl start', 'E_NO_DAEMON');
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${info!.port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bh-token': info!.token ?? process.env.BH_TOKEN ?? '' },
      body: JSON.stringify({ cmd, args }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    die(
      `cannot reach the daemon on port ${info!.port} (${(e as Error).message})`,
      'run: browserctl stop && browserctl start',
      'E_DAEMON_DOWN',
    );
  }
  const data = await res!.json().catch(() => null);
  if (!data) die('the daemon returned a malformed response', `see ${P.daemonLogPath()}`, 'E_BAD_RESPONSE');
  if (!data.ok) die(data.error?.message ?? 'command failed', data.error?.hint, data.error?.code ?? 'E_BH');
  return data.result;
}

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

function jsonOut(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function humanMs(ms: unknown): string {
  return typeof ms === 'number' ? ` (${ms}ms)` : '';
}

function renderPageState(r: any): string {
  if (!r || r.url === undefined) return '';
  const bits = [`→ ${r.url}`, r.title ? `"${r.title}"` : null, r.tab ? `tab ${r.tab}/${r.tabs}` : null, r.status ? `HTTP ${r.status}` : null]
    .filter(Boolean)
    .join(' ');
  return bits;
}

function renderResult(cmd: string, r: any): void {
  if (globalJson) return jsonOut(r);
  switch (cmd) {
    case 'status':
    case 'start':
    case 'restart': {
      const lines = Object.entries(r)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => `  ${k.padEnd(14)} ${v}`);
      out(lines.join('\n'));
      return;
    }
    case 'snapshot': {
      out(r.text ?? JSON.stringify(r, null, 2));
      return;
    }
    case 'find': {
      if (!r.count) {
        out(`no element matched ${JSON.stringify(r.query)}`);
        return;
      }
      out(`${r.count} match(es) for ${JSON.stringify(r.query)}${r.truncated ? ' (truncated)' : ''}:`);
      for (const m of r.matches) {
        out(`  ${m.ref ? `[${m.ref}]` : '[no-ref]'} ${m.role ?? '?'} ${m.name ? JSON.stringify(m.name) : ''}${m.text ? ` — ${JSON.stringify(m.text)}` : ''}`);
      }
      return;
    }
    case 'text':
    case 'html': {
      out(r.text ?? r.html ?? '');
      out(`--- ${r.chars} chars${r.truncated ? ' (truncated)' : ''}`);
      return;
    }
    case 'screenshot': {
      out(`✓ screenshot ${r.width}x${r.height} ${Math.round((r.bytes ?? 0) / 1024)}KB${humanMs(r.ms)} -> ${r.path}`);
      out(`  ${r.note}`);
      return;
    }
    case 'logs': {
      if (!r.returned) {
        out(`no log entries (total ${r.total})`);
        return;
      }
      for (const e of r.entries) out(e);
      out(`--- ${r.returned}/${r.total} entries`);
      return;
    }
    case 'requests': {
      if (!r.returned) {
        out(`no requests recorded (total ${r.total})`);
        return;
      }
      for (const e of r.entries) out(e);
      out(`--- ${r.returned}/${r.total} requests`);
      return;
    }
    case 'downloads': {
      if (!r.count) {
        out(`no downloads in ${r.dir}`);
        return;
      }
      for (const d of r.downloads) out(`  ${Math.round(d.bytes / 1024)}KB  ${d.file}`);
      return;
    }
    case 'tabs': {
      for (const t of r.tabs) out(`  ${t.active ? '*' : ' '} ${t.index}. ${t.title ?? ''} ${t.url}`);
      return;
    }
    case 'window': {
      const b = r.bounds ?? {};
      out(`window ${r.windowId}: ${b.width}x${b.height} at (${b.left},${b.top}) ${b.windowState ?? ''}`);
      return;
    }
    default: {
      const line = [
        `✓ ${r.action ?? cmd}`,
        r.target !== undefined && r.target !== null ? `target=${r.target}` : null,
        r.ref ? `ref=${r.ref}` : null,
        r.key ? `key=${r.key}` : null,
        r.chars !== undefined ? `${r.chars} chars` : null,
        r.submitted ? 'submitted' : null,
        r.grep ? `grep=${r.grep}` : null,
      ]
        .filter(Boolean)
        .join(' ');
      out(`${line}${humanMs(r.ms)}`);
      const state = renderPageState(r);
      if (state) out(`  ${state}`);
      if (r.hint) out(`  hint: ${r.hint}`);
    }
  }
}

// -------------------------------------------------------------- local helpers

async function cmdDoctor(): Promise<void> {
  const pw = await import('./pw.ts');
  const info = await probe(1500);
  const report: Record<string, unknown> = {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    harnessRoot: P.harnessRoot(),
    stateDir: P.stateDir(),
    profileDir: P.profileDir(),
    playwrightReady: false,
    daemonRunning: Boolean(info),
    daemonPid: info?.info.pid ?? null,
    daemonPort: info?.info.port ?? null,
    window: info?.health?.headless === undefined ? null : info.health.headless ? 'headless' : 'visible',
    logFile: P.daemonLogPath(),
  };
  Object.assign(report, await pw.describePlaywright());
  if (globalJson) return jsonOut(report);
  for (const [k, v] of Object.entries(report)) out(`  ${k.padEnd(20)} ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  if (!report.playwrightOk) out('\n  fix: npm i -g playwright && playwright install chromium   (or set BH_PLAYWRIGHT)');
  if (report.playwrightOk && report.chromiumInstalled === false) out('\n  fix: playwright install chromium');
  if (!info) out('\n  daemon not running — start it with: browserctl start');
}

async function cmdProfile(): Promise<void> {
  const info = readInfo();
  const entries = [
    { key: 'harnessRoot', value: P.harnessRoot() },
    { key: 'profile', value: info?.profile ?? P.profileDir() },
    { key: 'stateDir', value: info?.stateDir ?? P.stateDir() },
    { key: 'screenshots', value: P.shotsDir() },
    { key: 'downloads', value: P.downloadsDir() },
    { key: 'daemonLog', value: P.daemonLogPath() },
  ];
  if (globalJson) return jsonOut(entries);
  for (const e of entries) out(`  ${e.key.padEnd(14)} ${e.value}`);
}

async function cmdStop(): Promise<void> {
  const info = readInfo();
  if (!info) {
    out('daemon is not running');
    return;
  }
  const alive = await probe(1200);
  if (!alive) {
    P.removeQuietly(P.daemonInfoPath());
    out(`removed a stale daemon record (pid ${info.pid} is gone)`);
    return;
  }
  try {
    await send('shutdown', {}, 5000);
  } catch {
    /* the daemon may exit before answering */
  }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (!(await probe(500))) {
      out('browser window closed, daemon stopped');
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  die('the daemon did not stop in time', `kill ${info.pid} manually`, 'E_STOP_TIMEOUT');
}

async function cmdStart(pos: string[], flags: Flags): Promise<void> {
  const url = pos[0];
  const running = await probe(1500);

  if (running && !flags.restart) {
    out(`daemon already running (pid ${running.info.pid}, port ${running.info.port}) — reusing it`);
    renderResult('status', await send('status'));
    return;
  }
  if (running && flags.restart) {
    await cmdStopQuiet();
  } else if (fs.existsSync(P.daemonInfoPath()) && !pidAlive(readInfo()?.pid)) {
    P.removeQuietly(P.daemonInfoPath());
  }

  if (flags.foreground) {
    const daemon = await import('./daemon.ts');
    const argv = ['--port', String(flagNum(flags, 'port', Number(process.env.BH_PORT || 8737)))];
    if (url) argv.push('--url', url);
    if (flags.headless) argv.push('--headless');
    if (flags['window-size']) argv.push('--window-size', String(flags['window-size']));
    if (flags['idle-timeout']) argv.push('--idle-timeout', String(flags['idle-timeout']));
    await daemon.main(argv);
    return;
  }

  const argv = [path.join(P.harnessRoot(), 'src', 'daemon.ts')];
  if (flags.port) argv.push('--port', String(flagNum(flags, 'port')));
  if (url) argv.push('--url', url);
  if (flags.headless) argv.push('--headless');
  if (flags['window-size']) argv.push('--window-size', String(flags['window-size']));
  if (flags['idle-timeout']) argv.push('--idle-timeout', String(flags['idle-timeout']));

  P.ensureDirs();
  const child = spawn(process.execPath, argv, { cwd: P.harnessRoot(), detached: true, stdio: 'ignore' });
  child.unref();

  const timeoutMs = Number(flags['start-timeout'] ?? 90000);
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    const alive = await probe(1200);
    if (alive) {
      last = alive;
      break;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!last) {
    die(
      `the daemon did not become ready within ${timeoutMs}ms`,
      `check ${P.daemonLogPath()} — first launch also unpacks Chromium if it is missing`,
      'E_START_TIMEOUT',
    );
  }
  if (globalJson) return jsonOut({ ...last.health, profile: last.info.profile });
  out(`✓ built-in browser window ready${last.health.headless ? ' (headless)' : ''}`);
  out(`  pid ${last.info.pid}  port ${last.info.port}  ${last.health.pages} tab(s)`);
  out(`  profile ${last.info.profile ?? P.profileDir()}`);
  if (!last.health.headless) out('  the window is a dedicated Chromium profile — log in there by hand if a site needs it');
  if (flags.snapshot !== false) out('  next: browserctl snapshot');
}

async function cmdStopQuiet(): Promise<void> {
  const info = readInfo();
  if (!info) return;
  try {
    await send('shutdown', {}, 4000);
  } catch {
    /* ignore */
  }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && (await probe(400))) await new Promise((r) => setTimeout(r, 250));
}

// --------------------------------------------------------------------- main

async function main(): Promise<void> {
  const { cmd, pos, flags } = parseArgv(process.argv.slice(2));
  globalJson = Boolean(flags.json);

  if (cmd === 'help' || flags.help) {
    process.stdout.write(HELP);
    return;
  }

  const timeout = flagNum(flags, 'timeout');
  const t = (dflt: number) => timeout ?? dflt;
  const withSnapshot = Boolean(flags.snapshot);

  const run = async (rpcCmd: string, args: any, renderAs = rpcCmd): Promise<void> => {
    const result = await send(rpcCmd, args, t(120000) + 15000);
    renderResult(renderAs, result);
    if (withSnapshot && !['snapshot', 'status', 'tabs', 'logs', 'requests', 'downloads'].includes(rpcCmd)) {
      out('');
      renderResult('snapshot', await send('snapshot', { depth: flagNum(flags, 'depth'), grep: flags.grep, maxLines: flagNum(flags, 'max-lines') }));
    }
  };

  const snapArgs = () => ({
    depth: flagNum(flags, 'depth'),
    boxes: Boolean(flags.boxes),
    grep: flags.grep === true ? undefined : flags.grep,
    maxLines: flagNum(flags, 'max-lines'),
    json: globalJson,
  });

  switch (cmd) {
    case 'start':
      return cmdStart(pos, flags);
    case 'stop':
      return cmdStop();
    case 'restart':
      return cmdStart(pos, { ...flags, restart: true });
    case 'doctor':
      return cmdDoctor();
    case 'profile':
      return cmdProfile();

    case 'status': {
      const info = await probe(1500);
      if (!info) {
        if (globalJson) return jsonOut({ running: false, log: P.daemonLogPath() });
        out('daemon is not running — start it with: browserctl start');
        return;
      }
      return run('status');
    }

    case 'snapshot':
      return run('snapshot', snapArgs());
    case 'goto':
      if (!pos[0]) die('goto needs a url', 'browserctl goto https://example.com');
      return run('goto', { url: pos[0], timeout: t(45000) });
    case 'back':
    case 'forward':
    case 'reload':
      return run(cmd, {});
    case 'focus':
      return run('focus', { target: pos[0] });
    case 'find':
      if (!pos.length) die('find needs a query', 'browserctl find 登录');
      return run('find', { query: pos.join(' '), limit: flagNum(flags, 'limit', 30) });
    case 'text':
      return run('text', { target: pos[0], maxChars: flagNum(flags, 'max-chars') });
    case 'html':
      return run('html', { target: pos[0] ?? 'body', maxChars: flagNum(flags, 'max-chars') });
    case 'screenshot':
      return run('screenshot', { target: pos[0], full: Boolean(flags.full), out: flags.out === true ? undefined : flags.out });

    case 'click':
    case 'dblclick':
      if (!pos[0]) die(`${cmd} needs a target`, 'browserctl snapshot   # then: browserctl click e12');
      return run(cmd, {
        target: pos[0],
        count: flagNum(flags, 'count', cmd === 'dblclick' ? 2 : 1),
        force: Boolean(flags.force),
        button: flags.button === true ? undefined : flags.button,
        timeout: t(15000),
      });
    case 'hover':
      if (!pos[0]) die('hover needs a target');
      return run('hover', { target: pos[0], timeout: t(15000) });
    case 'type':
    case 'fill': {
      if (pos.length < 2) die(`${cmd} needs a target and text`, `browserctl ${cmd} e4 "hello"`);
      const [target, ...rest] = pos;
      return run(cmd, {
        target,
        text: rest.join(' '),
        submit: Boolean(flags.submit),
        slow: Boolean(flags.slow),
        clear: flags['no-clear'] ? false : true,
        timeout: t(15000),
      });
    }
    case 'press': {
      if (!pos.length) die('press needs a key', 'browserctl press Enter');
      if (pos.length === 1) return run('press', { key: pos[0], timeout: t(15000) });
      return run('press', { target: pos[0], key: pos[1], timeout: t(15000) });
    }
    case 'select': {
      if (pos.length < 2) die('select needs a target and value(s)', 'browserctl select e6 Two');
      return run('select', { target: pos[0], values: pos.slice(1), timeout: t(15000) });
    }
    case 'check':
    case 'uncheck':
    case 'toggle':
      if (!pos[0]) die(`${cmd} needs a target`);
      return run(cmd, { target: pos[0], timeout: t(15000) });
    case 'upload': {
      if (pos.length < 2) die('upload needs a target and file(s)', 'browserctl upload e9 ./report.pdf');
      return run('upload', { target: pos[0], files: pos.slice(1), timeout: t(30000) });
    }
    case 'scroll': {
      const dir = (pos[0] ?? 'down').toLowerCase();
      const dirs = ['up', 'down', 'left', 'right', 'top', 'bottom'];
      if (!dirs.includes(dir)) return run('scroll', { target: pos[0], timeout: t(15000) });
      return run('scroll', { direction: dir, amount: flagNum(flags, 'amount', Number(pos[1] ?? 600)), timeout: t(15000) });
    }
    case 'wait': {
      const spec = pos[0];
      if (!spec) return run('wait', { loadState: flags['load-state'] ?? 'networkidle', text: flags.text, timeout: t(20000) });
      if (/^\d+(ms)?$/.test(spec)) return run('wait', { ms: Number(spec.replace('ms', '')), timeout: t(30000) });
      if (/^(load|domcontentloaded|networkidle)$/.test(spec)) return run('wait', { loadState: spec, timeout: t(30000) });
      if (spec.startsWith('text=')) return run('wait', { text: spec.slice(5), timeout: t(20000) });
      return run('wait', { selector: spec, state: flags.state ?? 'visible', timeout: t(20000) });
    }
    case 'eval': {
      if (!pos.length) die('eval needs code', 'browserctl eval "document.title"');
      return run('eval', { code: pos.join(' ') });
    }

    case 'tabs':
      return run('tabs', {});
    case 'newtab':
      return run('newtab', { url: pos[0] });
    case 'switchtab':
    case 'closetab': {
      if (!pos[0]) die(`${cmd} needs an index`, 'browserctl tabs');
      return run(cmd, { index: Number(pos[0]) });
    }

    case 'logs':
      return run('logs', {
        limit: flagNum(flags, 'limit', 50),
        kind: flags.kind === true ? undefined : flags.kind,
        level: flags.level === true ? undefined : flags.level,
        errorsOnly: Boolean(flags.errors),
        clear: Boolean(flags.clear),
      });
    case 'requests':
      return run('requests', {
        limit: flagNum(flags, 'limit', 50),
        failedOnly: Boolean(flags.failed),
        clear: Boolean(flags.clear),
      });
    case 'downloads':
      return run('downloads', {});
    case 'window': {
      const args: any = { set: false };
      for (const k of ['left', 'top', 'width', 'height', 'state']) {
        if (flags[k] !== undefined && flags[k] !== true) {
          args[k] = k === 'state' ? String(flags[k]) : flagNum(flags, k);
          args.set = true;
        }
      }
      return run('window', args);
    }

    default:
      die(`unknown command "${cmd}"`, 'run: browserctl help', 'E_UNKNOWN_CMD');
  }
}

main().catch((e) => die((e as Error).message, (e as any).hint, (e as any).code ?? 'E_CLI'));
