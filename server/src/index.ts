import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import { env } from './env.js';
import { logger } from './logger.js';
import { interviewRouter } from './routes/interviews.js';
import { systemRouter } from './routes/system.js';
import { interviewService } from './services/interviews.js';

const here = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.use('/api', systemRouter);
app.use('/api/interviews', interviewRouter);

// Serve the built React app when it exists (production / single-origin deploys).
const webDist = resolve(here, '../../web/dist');
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(resolve(webDist, 'index.html'));
  });
}

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled request error', {
    error: error instanceof Error ? error.message : String(error),
  });
  res.status(500).json({ error: 'Internal server error' });
});

// Reconcile any interviews left mid-call by a previous process before serving.
interviewService.recover();

const server = app.listen(env.PORT, () => {
  logger.info('AgentScrut server listening', {
    port: env.PORT,
    voiceProvider: env.VOICE_PROVIDER,
    maxSeconds: env.INTERVIEW_MAX_SECONDS,
    passThreshold: env.INTERVIEW_PASS_THRESHOLD,
  });
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    logger.error(`Port ${env.PORT} is already in use.`, {
      hint: `Stop the process using it (e.g. \`lsof -ti tcp:${env.PORT} | xargs kill\`) or set PORT to a free port in .env.`,
    });
    process.exit(1);
  }
  logger.error('Server error', { error: error.message });
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info('Shutting down', { signal });
    server.close(() => process.exit(0));
  });
}
