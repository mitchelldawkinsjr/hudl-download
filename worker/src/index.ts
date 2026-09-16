// Worker entry point. Polls media_jobs for due queued clip jobs, leases one
// at a time, runs the pipeline, and requeues/deads on failure. Writes a
// heartbeat every tick so the API readiness check can flag stale/dead
// workers. Runs until SIGINT/SIGTERM.
import { leaseDueJob, closePool } from './db.js';
import { processJob, requeueOrDead, makeAdapter } from './pipeline.js';
import { heartbeat } from './heartbeat.js';
import { config } from './config.js';
import pino from 'pino';

const log = pino({ level: config.logLevel, name: 'worker' });

let running = true;

async function tick(): Promise<void> {
  const job = await leaseDueJob(config.workerId, config.leaseMs);
  if (!job) {
    await heartbeat({ workerId: config.workerId, status: 'idle' });
    return;
  }
  log.info({ jobId: job.id, attempts: job.attempts }, 'leased job');
  await heartbeat({ workerId: config.workerId, status: 'processing', lastJobId: job.id });
  try {
    await processJob(job, { adapter: makeAdapter() });
  } catch (err) {
    await heartbeat({ workerId: config.workerId, status: 'error', lastJobId: job.id, lastError: err instanceof Error ? err.message : String(err) })
      .catch(() => {});
    await requeueOrDead(job, err).catch((e) => log.error({ err: e }, 'requeue failed'));
  }
}

async function loop(): Promise<void> {
  log.info({ workerId: config.workerId, pollMs: config.pollMs }, 'worker started');
  while (running) {
    try { await tick(); }
    catch (err) {
      log.error({ err }, 'tick failed');
      await heartbeat({ workerId: config.workerId, status: 'error', lastError: err instanceof Error ? err.message : String(err) })
        .catch(() => {});
    }
    await new Promise((r) => setTimeout(r, config.pollMs));
  }
  await closePool();
  log.info('worker stopped');
}

const stop = (sig: string) => () => {
  log.info({ sig }, 'stopping');
  running = false;
};
process.on('SIGINT', stop('SIGINT'));
process.on('SIGTERM', stop('SIGTERM'));

loop().catch((err) => { log.error({ err }, 'fatal'); process.exit(1); });
