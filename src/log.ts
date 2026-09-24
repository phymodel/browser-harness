// Tiny logger: stderr + append-only daemon.log (best effort, never throws).
import { appendLine, daemonLogPath, nowIso } from './paths.ts';

export function log(msg: string, extra?: unknown): void {
  const tail = extra === undefined ? '' : ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
  const line = `[${nowIso()}] ${msg}${tail}`;
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    /* ignore */
  }
  appendLine(daemonLogPath(), line);
}
