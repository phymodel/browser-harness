#!/usr/bin/env node
// setup — verify the environment and install the Chromium build this harness
// drives. Zero-dependency: uses whatever `playwright` already exists.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as P from '../src/paths.ts';
import { describePlaywright } from '../src/pw.ts';

const WANT_NODE = [22, 6, 0];
const argv = process.argv.slice(2);
const wantInstall = argv.includes('--install') || argv.includes('-y');
const skipBrowser = argv.includes('--no-browser');

function nodeOk(): { ok: boolean; version: string; why?: string } {
  const [maj, min] = process.versions.node.split('.').map(Number);
  const why = `Node >= ${WANT_NODE.join('.')} is required (TypeScript runs directly, no build step)`;
  return { ok: maj > WANT_NODE[0] || (maj === WANT_NODE[0] && min >= WANT_NODE[1]), version: process.version, why };
}

function findPlaywrightCli(): string | null {
  const local = path.join(P.harnessRoot(), 'node_modules', 'playwright', 'cli.js');
  if (fs.existsSync(local)) return local;
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    const cli = path.join(globalRoot, 'playwright', 'cli.js');
    if (fs.existsSync(cli)) return cli;
  } catch {
    /* npm missing */
  }
  for (const root of ['/opt/homebrew/lib/node_modules', '/usr/local/lib/node_modules', '/usr/lib/node_modules']) {
    const cli = path.join(root, 'playwright', 'cli.js');
    if (fs.existsSync(cli)) return cli;
  }
  return null;
}

async function main(): Promise<void> {
  const node = nodeOk();
  console.log(`harness root : ${P.harnessRoot()}`);
  console.log(`state dir    : ${P.stateDir()}`);
  console.log(`profile dir  : ${P.profileDir()}`);
  console.log(`node         : ${node.version}`);
  if (!node.ok) {
    console.error(`✗ ${node.why}`);
    process.exit(1);
  }

  let report = await describePlaywright();

  if (!report.playwrightOk) {
    console.error(`✗ playwright is not available: ${report.error}`);
    const cmd = 'npm i -g playwright';
    if (wantInstall) {
      console.log(`→ running: ${cmd}`);
      const res = spawnSync('npm', ['i', '-g', 'playwright'], { stdio: 'inherit' });
      if (res.status !== 0) process.exit(res.status ?? 1);
      report = await describePlaywright();
    } else {
      console.error(`  fix: ${cmd}          (or run: sh scripts/setup.sh --install)`);
      console.error('  or point BH_PLAYWRIGHT at an existing playwright directory');
      process.exit(2);
    }
  }

  if (!report.playwrightOk) process.exit(2);
  console.log(`playwright   : ${report.playwrightVersion ?? 'unknown'}`);
  console.log(`chromium     : ${report.chromiumExecutable ?? 'not found'}`);

  if (!report.chromiumInstalled && !skipBrowser) {
    const cli = findPlaywrightCli();
    if (!cli) {
      console.error('✗ cannot find the playwright CLI to install Chromium');
      process.exit(3);
    }
    console.log('→ installing Chromium (one-time download, ~180MB)…');
    const res = spawnSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });
    if (res.status !== 0) {
      console.error('✗ `playwright install chromium` failed');
      process.exit(res.status ?? 1);
    }
    report = await describePlaywright();
  }

  if (!report.chromiumInstalled) {
    console.error('✗ the Chromium build is still missing — rerun: sh scripts/setup.sh');
    process.exit(3);
  }

  P.ensureDirs();
  console.log('\n✓ ready.  Try:');
  console.log('  sh scripts/browserctl start https://example.com');
  console.log('  sh scripts/browserctl snapshot');
  console.log('  sh scripts/smoke.sh            # full self-test');
}

main().catch((e) => {
  console.error(`✗ setup failed: ${e?.message}`);
  process.exit(1);
});
