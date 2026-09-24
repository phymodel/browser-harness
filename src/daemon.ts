// Long-lived daemon: owns the built-in Chromium window and serves a tiny
// localhost JSON-RPC API that `browserctl` (and any other client) drives.
import crypto from 'node:crypto';
import http from 'node:http';
import { BrowserSession } from './session.ts';
import * as P from './paths.ts';
import { log } from './log.ts';

const DEFAULT_PORT = Number(process.env.BH_PORT || 8737);
const HOST = process.env.BH_HOST || '127.0.0.1';

type DaemonOptions = {
  port?: number;
  url?: string;
  headless?: boolean;
  windowSize?: string;
  idleTimeoutMs?: number;
  token?: string;
};

function parseArgv(argv: string[]): DaemonOptions {
  const opts: DaemonOptions = { port: DEFAULT_PORT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => argv[++i];
    switch (a) {
      case '--port':
        opts.port = Number(value());
        break;
      case '--url':
        opts.url = value();
        break;
      case '--headless':
        opts.headless = true;
        break;
      case '--window-size':
        opts.windowSize = value();
        break;
      case '--idle-timeout':
        opts.idleTimeoutMs = Number(value()) * 1000;
        break;
      case '--token':
        opts.token = value();
        break;
      default:
        if (a.startsWith('--')) log(`ignoring unknown daemon flag ${a}`);
    }
  }
  return opts;
}

function readBody(req: http.IncomingMessage, limit = 4 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function tokenMatches(expected: string, given: string | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function main(argv: string[] = []): Promise<void> {
  const opts = parseArgv(argv);
  P.ensureDirs();

  const token = opts.token || process.env.BH_TOKEN || crypto.randomBytes(24).toString('hex');
  const startedAt = Date.now();
  const session = new BrowserSession({
    headless: opts.headless,
    windowSize: opts.windowSize,
    idleTimeoutMs: opts.idleTimeoutMs,
  });

  let closing = false;
  let server: http.Server | null = null;
  let idleTimer: NodeJS.Timeout | null = null;

  const shutdown = async (reason: string, code = 0): Promise<void> => {
    if (closing) return;
    closing = true;
    log(`shutdown: ${reason}`);
    if (idleTimer) clearTimeout(idleTimer);
    P.removeQuietly(P.daemonInfoPath());
    try {
      await session.shutdown();
    } catch (e) {
      log(`browser close failed: ${(e as Error).message}`);
    }
    server?.close();
    setTimeout(() => process.exit(code), 250).unref();
  };

  const touchIdle = (): void => {
    if (!opts.idleTimeoutMs) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void shutdown(`idle timeout (${opts.idleTimeoutMs}ms)`), opts.idleTimeoutMs);
    idleTimer.unref?.();
  };

  await session.launch(opts.url);

  server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url || '/', `http://${HOST}`);
        if (req.method === 'GET' && url.pathname === '/health') {
          const pages = session.context?.pages().length ?? 0;
          sendJson(res, 200, {
            ok: true,
            pid: process.pid,
            port: (server?.address() as any)?.port ?? opts.port,
            version: P.VERSION,
            harnessRoot: P.harnessRoot(),
            profile: P.profileDir(),
            headless: session.headless,
            pages,
            lastError: session.lastError,
            uptimeMs: Date.now() - startedAt,
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/rpc') {
          if (process.env.BH_NO_AUTH !== '1' && !tokenMatches(token, req.headers['x-bh-token'] as string | undefined)) {
            sendJson(res, 401, { ok: false, error: { code: 'E_AUTH', message: 'missing or invalid x-bh-token' } });
            return;
          }
          touchIdle();
          const body = await readBody(req);
          let payload: any;
          try {
            payload = JSON.parse(body || '{}');
          } catch {
            sendJson(res, 400, { ok: false, error: { code: 'E_BAD_JSON', message: 'request body is not valid JSON' } });
            return;
          }
          const cmd = String(payload.cmd || '');
          try {
            const result = await session.dispatch(cmd, payload.args ?? {});
            sendJson(res, 200, { ok: true, result });
            if (cmd === 'shutdown') setTimeout(() => void shutdown('client requested shutdown'), 120);
          } catch (e: any) {
            log(`command failed: ${cmd}: ${e?.message}`);
            sendJson(res, 200, {
              ok: false,
              error: {
                code: e?.code ?? 'E_BH',
                message: e?.message ?? String(e),
                hint: e?.hint,
                stack: process.env.BH_DEBUG ? e?.stack : undefined,
              },
            });
          }
          return;
        }
        sendJson(res, 404, { ok: false, error: { code: 'E_NOT_FOUND', message: `no route for ${req.method} ${url.pathname}` } });
      } catch (e: any) {
        log(`request failed: ${e?.message}`);
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: { code: 'E_DAEMON', message: e?.message ?? String(e) } });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    let attempt = 0;
    const tryListen = (): void => {
      const port = (opts.port || DEFAULT_PORT) + attempt;
      server!.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && attempt < 20) {
          attempt++;
          tryListen();
          return;
        }
        reject(err);
      });
      server!.listen(port, HOST, () => {
        log(`daemon listening on http://${HOST}:${port}`);
        resolve();
      });
    };
    tryListen();
  });

  const port = (server.address() as any).port as number;
  P.writeJsonAtomic(P.daemonInfoPath(), {
    pid: process.pid,
    port,
    host: HOST,
    token,
    version: P.VERSION,
    harnessRoot: P.harnessRoot(),
    profile: P.profileDir(),
    stateDir: P.stateDir(),
    headless: session.headless,
    startedAt: new Date(startedAt).toISOString(),
    log: P.daemonLogPath(),
  });

  // The user closing the built-in browser window must not kill the daemon —
  // the next command launches a fresh window on the same profile.
  session.context?.on('close', () => log('browser context closed (window closed by user)'));
  touchIdle();

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGHUP', () => void shutdown('SIGHUP'));
  process.on('uncaughtException', (e) => {
    log(`uncaughtException: ${e?.message}`);
    void shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (e: any) => log(`unhandledRejection: ${e?.message ?? e}`));

  log(`daemon ready pid=${process.pid} port=${port} headless=${session.headless} profile=${P.profileDir()}`);
}

const isDirect = process.argv[1] && /daemon\.ts$/.test(process.argv[1]);
if (isDirect) {
  main(process.argv.slice(2)).catch((e) => {
    log(`daemon failed to start: ${e?.message}`);
    process.stderr.write(`${e?.stack ?? e}\n`);
    process.exit(1);
  });
}
