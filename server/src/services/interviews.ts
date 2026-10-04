import { randomUUID } from 'node:crypto';
import { bimpe, describeError } from '../bimpe.js';
import { db } from '../db.js';
import { env } from '../env.js';
import { interviewBus } from '../events.js';
import { logger } from '../logger.js';
import { buildInterviewerPrompt } from '../prompts.js';
import type {
  CreateInterviewInput,
  ImportTranscriptInput,
  InterviewRecord,
  TranscriptTurn,
} from '../types.js';
import { evaluateInterview } from './evaluator.js';
import { ensureProvisioned } from './provisioning.js';
import { normalizeRole, parseTranscriptText, mergeTurns, resolveCallConversations } from './transcript.js';
import { getVoiceProvider } from './voice.js';
import { notifyInterview } from './assistant.js';

const CALL_POLL_MS = 1_500;
const TRANSCRIPT_GRACE_POLL_MS = 3_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const TERMINAL_INTERVIEW_STATUSES = new Set(['completed', 'failed', 'expired']);

export class NotFoundError extends Error {}
export class ConflictError extends Error {}

export class InterviewService {
  private pollTimers = new Map<string, NodeJS.Timeout>();
  private capTimers = new Map<string, NodeJS.Timeout>();
  private ringTimers = new Map<string, NodeJS.Timeout>();
  private streamControllers = new Map<string, AbortController>();
  private polling = new Set<string>();

  list(): InterviewRecord[] {
    return db.listInterviews();
  }

  get(id: string): InterviewRecord | null {
    return db.getInterview(id);
  }

  create(input: CreateInterviewInput): InterviewRecord {
    const now = new Date().toISOString();
    const record: InterviewRecord = {
      id: randomUUID(),
      jobTitle: input.jobTitle,
      jobDescription: input.jobDescription,
      seniority: input.seniority ?? null,
      keyRequirements: input.keyRequirements ?? [],
      candidateName: input.candidateName,
      candidatePhone: input.candidatePhone,
      passThreshold: input.passThreshold ?? env.INTERVIEW_PASS_THRESHOLD,
      status: 'created',
      agentId: null,
      workflowId: null,
      callId: null,
      callStatus: null,
      transcript: [],
      scorecard: null,
      summary: null,
      summaryError: null,
      error: null,
      createdAt: now,
      startedAt: null,
      endedAt: null,
      durationSeconds: null,
    };

    db.createInterview(record);
    interviewBus.publish(record.id, 'created', `Interview created for ${input.candidateName} (${input.jobTitle})`);
    return record;
  }

  private require(id: string): InterviewRecord {
    const record = db.getInterview(id);
    if (!record) throw new NotFoundError(`Interview ${id} not found`);
    return record;
  }

  private activeCall(): InterviewRecord | null {
    return (
      db.listInterviews().find((item) => {
        if (item.status !== 'calling' && item.status !== 'in_progress') return false;
        if (!item.startedAt) return false;
        const ageSeconds = (Date.now() - new Date(item.startedAt).getTime()) / 1000;
        return ageSeconds <= env.INTERVIEW_MAX_SECONDS;
      }) ?? null
    );
  }

  /**
   * Reconcile interviews left mid-call by a previous process. Recently-started
   * calls resume monitoring; anything older than the cap is marked expired so it
   * can never deadlock the single-call guard.
   */
  recover(): void {
    for (const record of db.listInterviews()) {
      if (record.status !== 'calling' && record.status !== 'in_progress') continue;
      const ageSeconds = record.startedAt
        ? (Date.now() - new Date(record.startedAt).getTime()) / 1000
        : Number.POSITIVE_INFINITY;

      if (ageSeconds > env.INTERVIEW_MAX_SECONDS) {
        db.updateInterview(record.id, {
          status: 'expired',
          error: record.error ?? 'Recovered after a restart; the call state is unknown.',
          endedAt: record.endedAt ?? new Date().toISOString(),
        });
        interviewBus.publish(record.id, 'completed', 'Interview expired during restart recovery.');
        logger.warn('Expired stale in-progress interview on startup', { interviewId: record.id });
      } else if (record.callId && record.agentId) {
        this.schedule(record.id);
        logger.info('Resumed monitoring an in-progress interview', { interviewId: record.id });
      }
    }
  }

  /** Place the outbound screening call and begin monitoring it. */
  async start(id: string): Promise<InterviewRecord> {
    let record = this.require(id);

    if (TERMINAL_INTERVIEW_STATUSES.has(record.status)) {
      throw new ConflictError(`Interview is already ${record.status}`);
    }
    if (record.status === 'calling' || record.status === 'in_progress') {
      return record;
    }

    const active = this.activeCall();
    if (active && active.id !== id) {
      throw new ConflictError(
        `Another interview is in progress (${active.id}). Wait for it to finish: the shared voice agent handles one call at a time.`,
      );
    }

    if (!db.getAgent('interviewer') || !db.getAgent('evaluator')) {
      interviewBus.publish(id, 'provisioning', 'Provisioning BimpeAI agents…');
      const summary = await ensureProvisioned();
      for (const note of summary.notes) interviewBus.publish(id, 'notice', note);
      if (!summary.agents.interviewer) {
        throw new Error('Interviewer agent could not be provisioned.');
      }
    }

    const interviewer = db.getAgent('interviewer');
    if (!interviewer) throw new Error('Interviewer agent is not available.');

    try {
      // Specialise the shared workflow for this role immediately before the call.
      const systemPrompt = buildInterviewerPrompt(record, {
        agentName: interviewer.name,
        maxSeconds: env.INTERVIEW_MAX_SECONDS,
      });
      await bimpe.workflows.update(interviewer.workflowId, { system_prompt: systemPrompt });

      interviewBus.publish(id, 'calling', `Dialing ${record.candidatePhone}…`);

      const provider = getVoiceProvider();
      const { callId } = await provider.startCall(interviewer.agentId, record.candidatePhone);

      record = this.require(id);
      record = db.updateInterview(id, {
        status: 'calling',
        agentId: interviewer.agentId,
        workflowId: interviewer.workflowId,
        callId,
        callStatus: 'initiated',
        startedAt: new Date().toISOString(),
        error: null,
      })!;

      interviewBus.publish(id, 'call_started', `Call ${callId} initiated`, { callId });
      this.schedule(id);
      return record;
    } catch (error) {
      const detail = describeError(error);
      const failed = db.updateInterview(id, { status: 'failed', error: detail })!;
      interviewBus.publish(id, 'error', `Could not start call: ${detail}`);
      throw new Error(detail);
    }
  }

  private schedule(id: string): void {
    this.clearTimers(id);

    const poll = setInterval(() => {
      void this.tick(id);
    }, CALL_POLL_MS);
    this.pollTimers.set(id, poll);

    const cap = setTimeout(() => {
      interviewBus.publish(id, 'cap_reached', 'Reached the maximum interview duration; ending the call.');
      void this.finalize(id, { reason: 'max_duration' });
    }, env.INTERVIEW_MAX_SECONDS * 1000);
    this.capTimers.set(id, cap);

    if (env.INTERVIEW_RING_TIMEOUT_SECONDS > 0) {
      const ring = setTimeout(() => {
        const record = db.getInterview(id);
        // Only fire if the candidate never picked up.
        if (!record || record.status !== 'calling') return;
        interviewBus.publish(id, 'ring_timeout', 'No answer after ringing; releasing the line.');
        void this.finalize(id, { reason: 'no_answer' });
      }, env.INTERVIEW_RING_TIMEOUT_SECONDS * 1000);
      this.ringTimers.set(id, ring);
    }

    // Best-effort live capture: stream the call's conversation(s) for turns as
    // they happen. If the platform only publishes (never persists) call turns,
    // this is what puts them on screen. Failures are silent; polling stays
    // the source of truth.
    const controller = new AbortController();
    this.streamControllers.set(id, controller);
    this.watchStream(id, controller.signal);
  }

  private clearTimers(id: string): void {
    const poll = this.pollTimers.get(id);
    if (poll) clearInterval(poll);
    this.pollTimers.delete(id);

    const cap = this.capTimers.get(id);
    if (cap) clearTimeout(cap);
    this.capTimers.delete(id);

    const ring = this.ringTimers.get(id);
    if (ring) clearTimeout(ring);
    this.ringTimers.delete(id);

    const stream = this.streamControllers.get(id);
    if (stream) stream.abort();
    this.streamControllers.delete(id);
  }

  private clearRingTimer(id: string): void {
    const ring = this.ringTimers.get(id);
    if (ring) clearTimeout(ring);
    this.ringTimers.delete(id);
  }

  /**
   * Follow the call's conversation stream(s) and append live turns to the
   * record. Purely additive: every failure is swallowed, polling remains the
   * source of truth, and duplicates are filtered by id and content.
   */
  private watchStream(id: string, signal: AbortSignal): void {
    void (async () => {
      try {
        let agentId: string | null = null;
        let phone: string | null = null;
        for (let attempt = 0; attempt < 20 && !signal.aborted; attempt++) {
          const record = db.getInterview(id);
          if (!record || TERMINAL_INTERVIEW_STATUSES.has(record.status)) return;
          if (record.agentId && record.callId) {
            agentId = record.agentId;
            phone = record.candidatePhone;
            break;
          }
          await sleep(3000);
        }
        if (!agentId || !phone || signal.aborted) return;

        let conversationIds: string[] = [];
        for (let attempt = 0; attempt < 24 && !signal.aborted; attempt++) {
          conversationIds = await resolveCallConversations(agentId, phone);
          if (conversationIds.length > 0) break;
          await sleep(5000);
        }
        if (conversationIds.length === 0 || signal.aborted) return;

        const agent = agentId;
        await Promise.all(
          conversationIds.map((conversationId) =>
            this.streamConversation(id, agent, conversationId, signal),
          ),
        );
      } catch (error) {
        if (!signal.aborted) {
          logger.warn('Conversation stream watcher stopped', {
            interviewId: id,
            error: describeError(error),
          });
        }
      }
    })();
  }

  private async streamConversation(
    id: string,
    agentId: string,
    conversationId: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      let index = 0;
      const stream = bimpe.conversations.messages.stream(agentId, conversationId, {
        signal,
        maxRetries: 50,
      });
      for await (const event of stream) {
        if (signal.aborted) return;
        const message = (event.message ?? '').trim();
        if (!message) continue;
        const turn: TranscriptTurn = {
          id: event.id || `stream-${conversationId}-${index++}`,
          role: normalizeRole(event.role ?? 'user'),
          message,
          createdAt: event.created_at ?? new Date().toISOString(),
        };
        const record = db.getInterview(id);
        if (!record || TERMINAL_INTERVIEW_STATUSES.has(record.status)) return;
        const known = record.transcript.some(
          (existing) =>
            existing.id === turn.id ||
            (existing.role === turn.role &&
              existing.message === turn.message &&
              existing.createdAt === turn.createdAt),
        );
        if (known) continue;
        db.updateInterview(id, { transcript: [...record.transcript, turn] });
        interviewBus.publish(id, 'transcript', turn.message, {
          turnId: turn.id,
          role: turn.role,
          createdAt: turn.createdAt,
        });
      }
    } catch (error) {
      if (!signal.aborted) {
        logger.warn('Conversation stream ended early', {
          interviewId: id,
          conversationId,
          error: describeError(error),
        });
      }
    }
  }

  private async tick(id: string): Promise<void> {
    if (this.polling.has(id)) return;
    const record = db.getInterview(id);
    if (!record || !record.callId || !record.agentId) {
      this.clearTimers(id);
      return;
    }
    if (TERMINAL_INTERVIEW_STATUSES.has(record.status)) {
      this.clearTimers(id);
      return;
    }

    this.polling.add(id);
    try {
      const provider = getVoiceProvider();
      const snapshot = await provider.getCall(record.agentId, record.callId);

      // Append only the newly-arrived transcript turns.
      const known = new Set(record.transcript.map((turn) => turn.id));
      const fresh = snapshot.transcript.filter((turn) => !known.has(turn.id));
      if (fresh.length > 0) {
        db.updateInterview(id, { transcript: [...record.transcript, ...fresh] });
        for (const turn of fresh) {
          interviewBus.publish(id, 'transcript', turn.message, {
            turnId: turn.id,
            role: turn.role,
            createdAt: turn.createdAt,
          });
        }
      }

      const nextStatus =
        snapshot.status === 'answered' && record.status !== 'in_progress' ? 'in_progress' : record.status;

      db.updateInterview(id, {
        callStatus: snapshot.status,
        durationSeconds: snapshot.durationSeconds,
        status: nextStatus,
      });

      // Once the candidate answers, the ring timeout is irrelevant.
      if (snapshot.answered) this.clearRingTimer(id);

      if (nextStatus === 'in_progress' && record.status === 'calling') {
        interviewBus.publish(id, 'in_progress', 'Candidate answered; interview in progress.');
      }

      if (snapshot.ended) {
        await this.finalize(id, { snapshot });
      }
    } catch (error) {
      logger.warn('Call poll failed', { interviewId: id, error: describeError(error) });
    } finally {
      this.polling.delete(id);
    }
  }

  /** Score the interview, then summarise it for the owner. */
  async finalize(id: string, options?: { reason?: string; snapshot?: Awaited<ReturnType<ReturnType<typeof getVoiceProvider>['getCall']>> }): Promise<InterviewRecord> {
    this.clearTimers(id);

    let record = this.require(id);
    if (TERMINAL_INTERVIEW_STATUSES.has(record.status)) return record;

    // Best-effort final snapshot to capture the closing moments of the call.
    if (!options?.snapshot && record.callId && record.agentId) {
      try {
        const provider = getVoiceProvider();
        options = { ...options, snapshot: await provider.getCall(record.agentId, record.callId) };
      } catch (error) {
        logger.warn('Final call snapshot failed', { interviewId: id, error: describeError(error) });
      }
    }

    const snapshot = options?.snapshot;
    if (snapshot) {
      const known = new Set(record.transcript.map((turn) => turn.id));
      const fresh = snapshot.transcript.filter((turn) => !known.has(turn.id));
      if (fresh.length > 0) record = db.updateInterview(id, { transcript: [...record.transcript, ...fresh] })!;
    }

    const durationSeconds =
      snapshot?.durationSeconds ??
      (record.startedAt ? Math.round((Date.now() - new Date(record.startedAt).getTime()) / 1000) : 0);

    const neverAnswered = options?.reason === 'no_answer' || Boolean(snapshot && !snapshot.answered);
    const failedStatus = Boolean(snapshot && ['failed', 'busy', 'cancelled'].includes(snapshot.status));
    const failed = neverAnswered || failedStatus;
    const errorReason = neverAnswered
      ? 'Candidate did not answer the call.'
      : failedStatus
        ? snapshot?.errorReason ?? 'Call did not complete'
        : record.error;

    record = db.updateInterview(id, {
      status: failed ? 'failed' : 'completed',
      callStatus: snapshot?.status ?? record.callStatus,
      durationSeconds,
      endedAt: new Date().toISOString(),
      error: errorReason,
    })!;

    interviewBus.publish(
      id,
      'call_ended',
      failed ? 'Call ended without a completed interview.' : 'Call ended; scoring candidate…',
      { durationSeconds, status: record.status },
    );

    if (record.transcript.length === 0 && !failed) {
      interviewBus.publish(id, 'notice', 'Call ended; waiting for BimpeAI to return the transcript…');
      const collected = await this.collectTranscriptWithGrace(id, record);
      if (collected.length > 0) {
        record = db.updateInterview(id, { transcript: collected })!;
        for (const turn of collected) {
          interviewBus.publish(id, 'transcript', turn.message, {
            turnId: turn.id,
            role: turn.role,
            createdAt: turn.createdAt,
          });
        }
      }
    }

    if (record.transcript.length === 0) {
      if (failed) {
        interviewBus.publish(id, 'notice', errorReason ?? 'Call did not complete; nothing to score.');
        return this.notifyAndStore(id, record);
      }
      interviewBus.publish(
        id,
        'transcript_missing',
        'BimpeAI returned no transcript for this call. Call transcription may need to be enabled; you can paste a transcript below to score it.',
      );
      return this.notifyAndStore(id, record);
    }

    record = await this.scoreAndNotify(id, record);
    interviewBus.publish(id, 'completed', 'Interview pipeline finished.');
    return this.require(id);
  }

  /** Score the candidate, then send the owner a short summary via the Hiring Assistant. */
  private async scoreAndNotify(id: string, record: InterviewRecord): Promise<InterviewRecord> {
    const scorecard = await evaluateInterview(record);
    record = db.updateInterview(id, { scorecard })!;
    interviewBus.publish(id, 'scorecard', `Scorecard ready: ${scorecard.overallScore}/100 (${scorecard.decision})`, {
      overallScore: scorecard.overallScore,
      decision: scorecard.decision,
      source: scorecard.source,
    });

    return this.notifyAndStore(id, record);
  }

  /**
   * Send the Hiring Assistant's short summary for this interview to the owner on
   * WhatsApp and store it on the record so the UI can show it.
   */
  private async notifyAndStore(id: string, record: InterviewRecord): Promise<InterviewRecord> {
    interviewBus.publish(id, 'summary_sending', 'Sending a short summary to the owner on WhatsApp…');
    const result = await notifyInterview(record);
    const updated = db.updateInterview(id, { summary: result.summary, summaryError: result.error })!;
    if (result.sent) {
      interviewBus.publish(id, 'summary_sent', 'Sent the interview summary to the owner on WhatsApp.');
    } else {
      interviewBus.publish(id, 'summary_failed', `Could not send the summary: ${result.error ?? 'unknown error'}`);
    }
    return updated;
  }

  /**
   * Some platforms publish a call's transcript shortly after it ends. Poll both
   * transcript sources for a short grace window before concluding it is absent.
   */
  private async collectTranscriptWithGrace(id: string, record: InterviewRecord): Promise<TranscriptTurn[]> {
    if (!record.callId || !record.agentId || env.INTERVIEW_TRANSCRIPT_GRACE_SECONDS <= 0) {
      return record.transcript;
    }

    const deadline = Date.now() + env.INTERVIEW_TRANSCRIPT_GRACE_SECONDS * 1000;
    let turns = record.transcript;

    while (Date.now() < deadline) {
      await sleep(TRANSCRIPT_GRACE_POLL_MS);
      try {
        const provider = getVoiceProvider();
        const snapshot = await provider.getCall(record.agentId, record.callId);
        turns = mergeTurns(turns, snapshot.transcript);
        if (turns.length > 0) return turns;
      } catch (error) {
        logger.warn('Transcript grace poll failed', { interviewId: id, error: describeError(error) });
      }
    }
    return turns;
  }

  /** Re-run just the evaluation + summary for a finished interview. */
  async rerunEvaluation(id: string): Promise<InterviewRecord> {
    const record = this.require(id);
    if (record.transcript.length === 0) throw new ConflictError('No transcript to evaluate.');

    const scorecard = await evaluateInterview(record);
    let updated = db.updateInterview(id, { scorecard })!;
    interviewBus.publish(id, 'scorecard', `Re-scored: ${scorecard.overallScore}/100 (${scorecard.decision})`, {
      overallScore: scorecard.overallScore,
      decision: scorecard.decision,
      source: scorecard.source,
    });

    updated = await this.notifyAndStore(id, updated);
    return updated;
  }

  /** Re-send the hiring assistant summary for a finished interview (operator action). */
  async resendSummary(id: string): Promise<InterviewRecord> {
    const record = this.require(id);
    return this.notifyAndStore(id, record);
  }

  /**
   * Replace the transcript from pasted text or structured turns, then score and
   * summarise. Lets the pipeline complete while platform call transcription is
   * unavailable.
   */
  async importTranscript(id: string, input: ImportTranscriptInput): Promise<InterviewRecord> {
    let record = this.require(id);

    const turns: TranscriptTurn[] =
      input.turns && input.turns.length > 0
        ? input.turns
            .map((turn, index) => ({
              id: `import-${Date.now()}-${index}`,
              role: normalizeRole(turn.role),
              message: turn.message.trim(),
              createdAt: turn.createdAt ?? new Date(Date.now() + index * 1000).toISOString(),
            }))
            .filter((turn) => turn.message.length > 0)
        : parseTranscriptText(input.transcript ?? '', { candidateName: record.candidateName });

    if (turns.length === 0) {
      throw new ConflictError('No transcript turns could be parsed from the provided input.');
    }

    const now = Date.now();
    record = db.updateInterview(id, {
      transcript: turns,
      status: TERMINAL_INTERVIEW_STATUSES.has(record.status) ? record.status : 'completed',
      callStatus: record.callStatus ?? 'ended',
      startedAt: record.startedAt ?? new Date(now).toISOString(),
      endedAt: record.endedAt ?? new Date(now).toISOString(),
      durationSeconds:
        record.durationSeconds ??
        (record.startedAt ? Math.round((now - new Date(record.startedAt).getTime()) / 1000) : null),
      error: null,
    })!;

    for (const turn of turns) {
      interviewBus.publish(id, 'transcript', turn.message, {
        turnId: turn.id,
        role: turn.role,
        createdAt: turn.createdAt,
      });
    }
    interviewBus.publish(id, 'notice', `Imported ${turns.length} transcript turns.`);

    if (input.evaluate === false) return this.require(id);

    record = await this.scoreAndNotify(id, record);
    interviewBus.publish(id, 'completed', 'Interview pipeline finished from imported transcript.');
    return this.require(id);
  }

  /** Forcefully end monitoring and mark an interview expired (operator action). */
  async cancel(id: string): Promise<InterviewRecord> {
    this.clearTimers(id);
    const record = this.require(id);
    if (TERMINAL_INTERVIEW_STATUSES.has(record.status)) return record;
    const updated = db.updateInterview(id, {
      status: 'expired',
      endedAt: new Date().toISOString(),
      callStatus: 'ended',
      error: record.error ?? 'Cancelled by operator.',
    })!;
    interviewBus.publish(id, 'completed', 'Interview cancelled by operator.');
    return updated;
  }

  /**
   * Call the candidate again: clear the previous attempt's call, transcript,
   * score and summary, then place a fresh outbound call. The single-call
   * guard still applies.
   */
  async redial(id: string): Promise<InterviewRecord> {
    const record = this.require(id);
    if (record.status === 'calling' || record.status === 'in_progress') {
      throw new ConflictError('This interview already has a live call.');
    }

    db.updateInterview(id, {
      status: 'created',
      agentId: null,
      workflowId: null,
      callId: null,
      callStatus: null,
      transcript: [],
      scorecard: null,
      summary: null,
      summaryError: null,
      error: null,
      startedAt: null,
      endedAt: null,
      durationSeconds: null,
    });
    interviewBus.publish(id, 'redial', `Calling ${record.candidatePhone} again…`);
    return this.start(id);
  }

  /**
   * Inject a synthetic transcript and run the scoring + summary pipeline. Useful
   * for demoing end-to-end before a telephony number is provisioned.
   */
  async simulate(id: string, transcript?: TranscriptTurn[]): Promise<InterviewRecord> {
    let record = this.require(id);
    if (TERMINAL_INTERVIEW_STATUSES.has(record.status)) {
      throw new ConflictError(`Interview is already ${record.status}`);
    }

    const turns = transcript && transcript.length > 0 ? transcript : this.syntheticTranscript(record);
    record = db.updateInterview(id, {
      transcript: turns,
      status: 'completed',
      startedAt: record.startedAt ?? new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationSeconds: record.durationSeconds ?? Math.min(env.INTERVIEW_MAX_SECONDS, 240),
      callStatus: 'ended',
      error: null,
    })!;

    for (const turn of turns) {
      interviewBus.publish(id, 'transcript', turn.message, { turnId: turn.id, role: turn.role, createdAt: turn.createdAt });
    }
    interviewBus.publish(id, 'call_ended', 'Simulated interview ended; scoring candidate…');

    const scorecard = await evaluateInterview(record);
    record = db.updateInterview(id, { scorecard })!;
    interviewBus.publish(id, 'scorecard', `Scorecard ready: ${scorecard.overallScore}/100 (${scorecard.decision})`, {
      overallScore: scorecard.overallScore,
      decision: scorecard.decision,
      source: scorecard.source,
    });

    record = await this.notifyAndStore(id, record);
    interviewBus.publish(id, 'completed', 'Simulated interview pipeline finished.');
    return this.require(id);
  }

  private syntheticTranscript(record: InterviewRecord): TranscriptTurn[] {
    const now = Date.now();
    const lines: Array<[string, string]> = [
      ['assistant', `Hi ${record.candidateName}, thanks for taking my call. I'm screening for the ${record.jobTitle} role. Do you have a few minutes?`],
      ['user', 'Yes, of course. Happy to talk.'],
      ['assistant', `Great. Could you walk me through your most relevant experience for a ${record.jobTitle} position?`],
      ['user', `I have spent the last several years working directly on ${record.jobTitle.toLowerCase()} responsibilities, owning projects end to end and shipping results with measurable impact.`],
      ['assistant', 'Tell me about a specific challenge you ran into and how you handled it.'],
      ['user', 'The hardest one was a timeline that slipped because of a dependency. I re-scoped the work, communicated risks early, and still delivered the core outcome on schedule.'],
      ['assistant', 'What tools or methods do you rely on day to day?'],
      ['user', 'I use the standard tooling for this field, and I focus on clear measurement so improvements are verifiable rather than assumed.'],
      ['assistant', 'Thanks, that is helpful. Do you have any questions for me?'],
      ['user', 'Not right now. Thank you for the opportunity.'],
      ['assistant', 'Thank you. The team will review and follow up. Have a great day.'],
    ];
    return lines.map(([role, message], index) => ({
      id: `sim-${record.id}-${index}`,
      role,
      message,
      createdAt: new Date(now + index * 1000).toISOString(),
    }));
  }
}

export const interviewService = new InterviewService();
