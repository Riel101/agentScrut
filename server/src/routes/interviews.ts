import { Router } from 'express';
import { db } from '../db.js';
import { interviewBus } from '../events.js';
import { createInterviewSchema, importTranscriptSchema } from '../types.js';
import {
  ConflictError,
  NotFoundError,
  interviewService,
} from '../services/interviews.js';
import type { InterviewEvent } from '../types.js';

export const interviewRouter = Router();

function handleError(error: unknown, res: import('express').Response): void {
  if (error instanceof NotFoundError) {
    res.status(404).json({ error: error.message });
    return;
  }
  if (error instanceof ConflictError) {
    res.status(409).json({ error: error.message });
    return;
  }
  res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
}

interviewRouter.get('/', (_req, res) => {
  res.json({ data: interviewService.list() });
});

interviewRouter.post('/', (req, res) => {
  const parsed = createInterviewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid interview', issues: parsed.error.issues });
    return;
  }
  try {
    const interview = interviewService.create(parsed.data);
    res.status(201).json({ data: interview });
  } catch (error) {
    handleError(error, res);
  }
});

interviewRouter.get('/:id', (req, res) => {
  const interview = interviewService.get(req.params.id);
  if (!interview) {
    res.status(404).json({ error: 'Interview not found' });
    return;
  }
  res.json({ data: interview });
});

interviewRouter.post('/:id/start', async (req, res) => {
  try {
    const interview = await interviewService.start(req.params.id);
    res.json({ data: interview });
  } catch (error) {
    handleError(error, res);
  }
});

/** Clear a finished attempt and place a fresh outbound call. */
interviewRouter.post('/:id/redial', async (req, res) => {
  try {
    const interview = await interviewService.redial(req.params.id);
    res.json({ data: interview });
  } catch (error) {
    handleError(error, res);
  }
});

interviewRouter.post('/:id/simulate', async (req, res) => {
  try {
    const interview = await interviewService.simulate(req.params.id);
    res.json({ data: interview });
  } catch (error) {
    handleError(error, res);
  }
});

interviewRouter.post('/:id/evaluate', async (req, res) => {
  try {
    const interview = await interviewService.rerunEvaluation(req.params.id);
    res.json({ data: interview });
  } catch (error) {
    handleError(error, res);
  }
});

/** Re-send the Hiring Assistant's performance summary to the owner. */
interviewRouter.post('/:id/summary', async (req, res) => {
  try {
    const interview = await interviewService.resendSummary(req.params.id);
    res.json({ data: interview });
  } catch (error) {
    handleError(error, res);
  }
});

/** Import a transcript (pasted text or structured turns), then score + summarise. */
interviewRouter.post('/:id/transcript', async (req, res) => {
  const parsed = importTranscriptSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid transcript', issues: parsed.error.issues });
    return;
  }
  try {
    const interview = await interviewService.importTranscript(req.params.id, parsed.data);
    res.json({ data: interview });
  } catch (error) {
    handleError(error, res);
  }
});

/** Force-end monitoring and mark an interview expired (operator action). */
interviewRouter.post('/:id/cancel', async (req, res) => {
  try {
    const interview = await interviewService.cancel(req.params.id);
    res.json({ data: interview });
  } catch (error) {
    handleError(error, res);
  }
});

/** Server-Sent Events stream of interview progress (with replay). */
interviewRouter.get('/:id/events', (req, res) => {
  const interviewId = req.params.id;
  if (!db.getInterview(interviewId)) {
    res.status(404).json({ error: 'Interview not found' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const send = (event: InterviewEvent) => {
    res.write(`id: ${event.id}\n`);
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const after = typeof req.query.after === 'string' ? req.query.after : undefined;
  for (const event of db.listEvents(interviewId, after)) send(event);

  const unsubscribe = interviewBus.subscribe(interviewId, send);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
});
