import { bimpe } from '../bimpe.js';
import { env } from '../env.js';
import type { TranscriptTurn } from '../types.js';
import {
  fetchConversationTurns,
  mergeTurns,
  resolveTelephonyConversation,
  turnFromRaw,
} from './transcript.js';

export interface CallSnapshot {
  callId: string;
  status: string;
  durationSeconds: number | null;
  transcript: TranscriptTurn[];
  /** True once the destination actually answered. */
  answered: boolean;
  /** True once the carrier/platform reports a terminal state. */
  ended: boolean;
  errorReason: string | null;
  endReason: string | null;
}

export interface VoiceProvider {
  readonly name: string;
  /** Place an outbound call from the agent's telephony channel. */
  startCall(agentId: string, destination: string): Promise<{ callId: string }>;
  /** Read the latest state and transcript for a call. */
  getCall(agentId: string, callId: string): Promise<CallSnapshot>;
}

const TERMINAL_STATUSES = new Set(['ended', 'busy', 'failed', 'cancelled']);

class BimpeVoiceProvider implements VoiceProvider {
  readonly name = 'bimpe';

  /** Cache call -> telephony conversation id so we resolve it only once. */
  private conversationCache = new Map<string, string>();

  async startCall(agentId: string, destination: string): Promise<{ callId: string }> {
    const result = await bimpe.calls.make(agentId, {
      destination,
      is_test_call: false,
    });

    if (result.status === 'failed' || !result.call_id) {
      throw new Error(result.detail ?? `Call could not be initiated (status=${result.status})`);
    }
    return { callId: result.call_id };
  }

  async getCall(agentId: string, callId: string): Promise<CallSnapshot> {
    const detail = await bimpe.calls.retrieve(agentId, callId);

    const callTurns: TranscriptTurn[] = detail.conversation_logs.map((entry, index) =>
      turnFromRaw(entry, `${callId}-log-${index}`),
    );

    // Some builds record the call as a telephony conversation instead of (or as
    // well as) conversation_logs, so merge both sources.
    let conversationTurns: TranscriptTurn[] = [];
    if (detail.destination) {
      let conversationId = this.conversationCache.get(callId);
      if (!conversationId) {
        conversationId = (await resolveTelephonyConversation(agentId, detail.destination)) ?? undefined;
        if (conversationId) this.conversationCache.set(callId, conversationId);
      }
      if (conversationId) conversationTurns = await fetchConversationTurns(agentId, conversationId);
    }

    return {
      callId: detail.id,
      status: detail.status,
      durationSeconds: detail.duration_seconds,
      transcript: mergeTurns(callTurns, conversationTurns),
      answered: Boolean(detail.answered_at),
      ended: TERMINAL_STATUSES.has(detail.status),
      errorReason: detail.error_reason,
      endReason: detail.end_reason,
    };
  }
}

/**
 * Fallback provider. KrosAI is telephony infrastructure that bridges a number to
 * a voice endpoint; it is not wired to a Bimpe agent, so using it means running
 * the interview on a KrosAI endpoint instead. This adapter covers the outbound
 * call only and requires KROS_FROM_NUMBER + KROS_ENDPOINT_ID.
 */
class KrosVoiceProvider implements VoiceProvider {
  readonly name = 'kros';

  private config(): { fromNumber: string; endpointId: string } {
    const fromNumber = process.env.KROS_FROM_NUMBER;
    const endpointId = process.env.KROS_ENDPOINT_ID;
    if (!env.KROS_API_KEY || !fromNumber || !endpointId) {
      throw new Error(
        'KrosAI provider selected but KROS_API_KEY, KROS_FROM_NUMBER and KROS_ENDPOINT_ID are not all set.',
      );
    }
    return { fromNumber, endpointId };
  }

  async startCall(_agentId: string, destination: string): Promise<{ callId: string }> {
    const { fromNumber, endpointId } = this.config();
    const response = await fetch(`${env.KROS_BASE_URL}/outbound-calls/outbound-call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.KROS_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from_number: fromNumber,
        to_number: destination,
        endpoint_id: endpointId,
        max_duration: env.INTERVIEW_MAX_SECONDS,
      }),
    });

    if (!response.ok) {
      throw new Error(`KrosAI call failed (${response.status}): ${await response.text()}`);
    }
    const payload = (await response.json()) as Record<string, unknown>;
    const callId =
      (payload.call_id as string | undefined) ??
      (payload.call_uuid as string | undefined) ??
      (payload.id as string | undefined);
    if (!callId) throw new Error('KrosAI did not return a call id.');
    return { callId };
  }

  async getCall(_agentId: string, callId: string): Promise<CallSnapshot> {
    const response = await fetch(`${env.KROS_BASE_URL}/calls/${callId}`, {
      headers: { Authorization: `Bearer ${env.KROS_API_KEY}` },
    });
    if (!response.ok) throw new Error(`KrosAI call lookup failed (${response.status})`);
    const payload = (await response.json()) as Record<string, unknown>;
    const status = String(payload.status ?? 'unknown');
    const transcript: TranscriptTurn[] = Array.isArray(payload.transcript)
      ? (payload.transcript as Array<Record<string, unknown>>).map((entry, index) => ({
          id: String(entry.id ?? `${callId}-${index}`),
          role: String(entry.role ?? entry.speaker ?? 'unknown'),
          message: String(entry.message ?? entry.text ?? ''),
          createdAt: String(entry.created_at ?? new Date().toISOString()),
        }))
      : [];

    return {
      callId,
      status,
      durationSeconds: typeof payload.duration === 'number' ? payload.duration : null,
      transcript,
      answered: ['answered', 'completed', 'ended', 'in-progress', 'in_progress'].includes(status),
      ended: ['completed', 'failed', 'no_answer', 'busy', 'ended'].includes(status),
      errorReason: (payload.error as string | undefined) ?? null,
      endReason: null,
    };
  }
}

export function getVoiceProvider(): VoiceProvider {
  return env.VOICE_PROVIDER === 'kros' ? new KrosVoiceProvider() : new BimpeVoiceProvider();
}
