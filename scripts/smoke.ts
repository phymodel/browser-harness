#!/usr/bin/env node
// smoke — isolated end-to-end self-test.
// Runs against a throwaway state dir + browser profile on a separate port, so it
// never touches a live browsing session.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as P from '../src/paths.ts';

const PORT = Number(process.env.BH_SMOKE_PORT || 8799);
const ROOT = path.join(os.tmpdir(), `bh-smoke-${process.pid}`);
const HEADLESS = process.argv.includes('--headless');
const env = {
  ...process.env,
  BH_STATE_DIR: path.join(ROOT, 'state'),
  BH_PROFILE_DIR: path.join(ROOT, 'profile'),
};

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>Smoke Fixture</title></head><body>
<h1>Smoke Fixture</h1>
<form onsubmit="event.preventDefault()">
  <label for="user">用户名</label>
  <input id="user" aria-label="用户名" placeholder="name">
  <label><input type="checkbox" id="cb"> 记住我</label>
  <select id="sel"><option>One</option><option>Two</option></select>
  <button id="go" type="button" onclick="document.getElementById('result').textContent='hello '+document.getElementById('user').value">提交</button>
  <button id="dis" disabled>Disabled</button>
</form>
<div id="result">-</div>
<iframe srcdoc="&lt;button id=&quot;inner&quot; onclick=&quot;parent.document.getElementById('result').textContent='inner-clicked'&quot;&gt;InnerBtn&lt;/button&gt;"></iframe>
<script>console.log('fixture-ready');</script>
</body></html>`;

let pass = 0;
let fail = 0;
const results: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++;
    results.push(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    results.push(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function ctl(args: string[], expectOk = true): any {
  const res = spawnSync(process.execPath, [path.join(P.harnessRoot(), 'src', 'cli.ts'), ...args, '--json'], {
    env,
    encoding: 'utf8',
    timeout: 180000,
  });
  const stdout = res.stdout?.trim() ?? '';
  const stderr = res.stderr?.trim() ?? '';
  const text = stdout || stderr;
  let parsed: any = null;
  const start = text.indexOf('{');
  if (start >= 0) {
    try {
      parsed = JSON.parse(text.slice(start));
    } catch {
      parsed = null;
    }
  }
  if (expectOk && (res.status !== 0 || parsed === null)) {
    throw new Error(`browserctl ${args.join(' ')} failed (exit ${res.status}): ${stderr || stdout}`);
  }
  return { status: res.status, out: parsed ?? { raw: text }, stderr };
}

function refFromSnapshot(pattern: string): string | null {
  const snap = ctl(['snapshot', '--grep', pattern]).out;
  const text: string = snap.text ?? '';
  const line = text.split('\n').find((l) => l.includes(pattern));
  if (!line) return null;
  const m = /\[ref=([a-z0-9]+)\]/.exec(line);
  return m ? m[1] : null;
}

function refFromFind(query: string): string | null {
  const found = ctl(['find', query]).out;
  for (const m of found.matches ?? []) if (m.ref) return m.ref;
  return null;
}

async function main(): Promise<void> {
  fs.mkdirSync(ROOT, { recursive: true });
  const fixture = path.join(ROOT, 'fixture.html');
  fs.writeFileSync(fixture, FIXTURE);
  const url = `file://${fixture}`;

  console.log(`smoke: state=${env.BH_STATE_DIR}`);
  console.log(`smoke: port=${PORT} headless=${HEADLESS}`);

  // 0. environment
  const doctor = ctl(['doctor']).out;
  check('playwright resolvable', Boolean(doctor.playwrightOk), String(doctor.playwrightVersion ?? ''));
  check('chromium installed', Boolean(doctor.chromiumInstalled), String(doctor.chromiumExecutable ?? ''));

  try {
    // 1. start the daemon + built-in window
    const started = ctl(['start', url, `--port=${PORT}`, ...(HEADLESS ? ['--headless'] : [])]).out;
    check('daemon started', Boolean(started.ok) && Boolean(started.port), `pid=${started.pid} port=${started.port}`);
    check('built-in window created', started.pages >= 1, `${started.pages} tab(s), headless=${started.headless}`);

    const status = ctl(['status']).out;
    check('status reports the page', String(status.url).startsWith('file://'), String(status.url));

    // 2. accessibility snapshot + refs
    const snap = ctl(['snapshot']).out;
    const snapText: string = snap.text ?? '';
    check('snapshot has an a11y tree', snapText.includes('[TREE]'));
    check('snapshot contains refs', /\[ref=[a-z0-9]+\]/.test(snapText), `${(snapText.match(/\[ref=/g) ?? []).length} refs`);
    check('snapshot sees the heading', snapText.includes('Smoke Fixture'));

    // 3. find + ref-based typing and clicking
    const userRef = refFromFind('用户名');
    check('find resolves the textbox ref', Boolean(userRef), `ref=${userRef}`);
    if (userRef) {
      ctl(['type', userRef, 'alice']);
      const submitRef = refFromFind('提交');
      check('find resolves the button ref', Boolean(submitRef), `ref=${submitRef}`);
      if (submitRef) ctl(['click', submitRef]);
      const after = ctl(['text', '#result']).out;
      check('typed value reached the page', String(after.text).includes('hello alice'), JSON.stringify(after.text));
    }

    // 4. checkbox via a11y state
    const cbRef = refFromFind('记住我');
    check('find resolves the checkbox ref', Boolean(cbRef), `ref=${cbRef}`);
    if (cbRef) {
      ctl(['check', cbRef]);
      const checked = ctl(['snapshot', '--grep', '记住我']).out;
      check('checkbox shows [checked]', String(checked.text).includes('[checked]'));
    }

    // 5. select by ref
    const selRef = refFromSnapshot('combobox');
    check('snapshot resolves the combobox ref', Boolean(selRef), `ref=${selRef}`);
    if (selRef) {
      const picked = ctl(['select', selRef, 'Two']).out;
      check('selectOption returns the picked value', JSON.stringify(picked.selected ?? '').includes('Two'), JSON.stringify(picked.selected));
    }

    // 6. iframe refs (frame-prefixed refs like f1e2)
    const innerRef = refFromSnapshot('InnerBtn');
    check('iframe element gets a ref', Boolean(innerRef), `ref=${innerRef}`);
    if (innerRef) {
      ctl(['click', innerRef]);
      const after = ctl(['text', '#result']).out;
      check('iframe click worked', String(after.text).includes('inner-clicked'), JSON.stringify(after.text));
    }

    // 7. stale ref must fail closed
    ctl(['goto', `${url}?v=2`]);
    const stale = ctl(['click', innerRef ?? 'e999999'], false);
    check(
      'stale ref fails closed with a hint',
      stale.status !== 0 && /stale/i.test(JSON.stringify(stale.out)),
      String(stale.out?.error?.code ?? stale.out?.error?.message ?? ''),
    );

    // 8. screenshot
    const shot = ctl(['screenshot', '--full']).out;
    check('screenshot written to disk', Boolean(shot.path) && fs.existsSync(shot.path) && fs.statSync(shot.path).size > 1000, `${shot.width}x${shot.height} ${shot.bytes}B`);

    // 9. console + network telemetry
    const logs = ctl(['logs']).out;
    check('console log captured', JSON.stringify(logs.entries ?? []).includes('fixture-ready'));
    const reqs = ctl(['requests']).out;
    check('request log captured', JSON.stringify(reqs.entries ?? []).includes('fixture.html'));

    // 10. eval
    const ev = ctl(['eval', 'document.title']).out;
    check('eval returns a value', ev.value === 'Smoke Fixture', JSON.stringify(ev.value));
    const ev2 = ctl(['eval', 'const a = 2; a * 21']).out;
    check('eval runs a multi-statement script', ev2.value === 42, JSON.stringify(ev2.value));
    const ev3 = ctl(['eval', '() => document.title.length']).out;
    check('eval calls an arrow function', typeof ev3.value === 'number', JSON.stringify(ev3.value));

    // 11. tabs
    ctl(['newtab', url]);
    const tabs = ctl(['tabs']).out;
    check('newtab added a tab', tabs.count === 2, `${tabs.count} tabs`);
    ctl(['switchtab', '1']);
    ctl(['closetab', '2']);
    const tabs2 = ctl(['tabs']).out;
    check('closetab removed a tab', tabs2.count === 1, `${tabs2.count} tabs`);

    // 12. window bounds (proves the real window is addressable)
    const win = ctl(['window']).out;
    check('window bounds readable', Boolean(win.bounds?.width), JSON.stringify(win.bounds));
  } catch (e) {
    fail++;
    results.push(`  ✗ aborted: ${(e as Error).message}`);
  } finally {
    const stopped = spawnSync(process.execPath, [path.join(P.harnessRoot(), 'src', 'cli.ts'), 'stop', '--json'], { env, encoding: 'utf8', timeout: 60000 });
    check('daemon stopped', !/browser window closed|stopped/.test(stopped.stdout ?? '') || (stopped.status ?? 1) === 0, (stopped.stdout ?? '').trim().split('\n')[0]);
  }

  console.log('\nSMOKE RESULT');
  for (const line of results) console.log(line);
  console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
  console.log(`artifacts: ${ROOT}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`smoke crashed: ${e?.stack ?? e}`);
  process.exit(1);
});
