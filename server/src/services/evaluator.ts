import type { Message } from '@bimpeai/sdk';
import { bimpe, describeError } from '../bimpe.js';
import { db } from '../db.js';
import { logger } from '../logger.js';
import { buildEvaluatorMessage } from '../prompts.js';
import { AGENTSCRUT_NAMESPACE, uuidV5 } from '../util.js';
import type { InterviewRecord, Scorecard, ScoreDimension } from '../types.js';

const REPLY_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 1_500;

/** Extract the first balanced JSON object from model output. */
export function extractJsonObject(text: string): unknown | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i += 1) {
    const char = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function clampScore(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}

export function parseScorecard(raw: string): Scorecard | null {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  const object = parsed as Record<string, unknown>;

  const decisionRaw = String(object.decision ?? '').toLowerCase();
  const decision: Scorecard['decision'] =
    decisionRaw === 'pass' || decisionRaw === 'fail' || decisionRaw === 'borderline'
      ? decisionRaw
      : 'borderline';

  const dimensions: ScoreDimension[] = Array.isArray(object.dimensions)
    ? (object.dimensions as Array<Record<string, unknown>>).map((dimension) => ({
        name: String(dimension.name ?? 'Dimension'),
        score: clampScore(dimension.score),
        rationale: String(dimension.rationale ?? ''),
      }))
    : [];

  return {
    decision,
    overallScore: clampScore(object.overallScore),
    dimensions,
    strengths: coerceStringArray(object.strengths),
    concerns: coerceStringArray(object.concerns),
    summary: String(object.summary ?? ''),
    recommendedNextStep: String(object.recommendedNextStep ?? ''),
    source: 'evaluator-agent',
    raw,
  };
}

/** Locate the test-webchat conversation used to talk to the evaluator agent. */
async function resolveConversation(agentId: string, channelUserId: string): Promise<string | null> {
  const page = await bimpe.conversations.list(agentId, {
    channel: 'test_webchat',
    limit: 100,
    sort: '-last_message_at',
  });
  const match = page.data.find((conversation) => conversation.channel_user_id === channelUserId);
  return match?.id ?? page.data[0]?.id ?? null;
}

/** Poll a conversation until an assistant message newer than `afterIso` appears. */
async function waitForAssistantReply(
  agentId: string,
  conversationId: string,
  afterIso: string,
): Promise<string | null> {
  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  let latest = '';

  while (Date.now() < deadline) {
    const page = await bimpe.conversations.messages.list(agentId, conversationId, {
      limit: 30,
      sort: '-created_at',
    });
    const assistantMessages = page.data
      .filter((message: Message) => message.role === 'assistant' && message.created_at > afterIso)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));

    if (assistantMessages.length > 0) {
      latest = assistantMessages
        .map((message) => message.message ?? '')
        .join('\n')
        .trim();
      if (extractJsonObject(latest)) return latest;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return latest || null;
}

/**
 * Heuristic scorecard used when the evaluator agent cannot be reached, so the
 * rest of the pipeline (summary, dashboard) still works in a demo.
 */
export function heuristicScorecard(interview: InterviewRecord, reason: string): Scorecard {
  const candidateTurns = interview.transcript.filter((turn) => turn.role !== 'assistant');
  const words = candidateTurns.reduce((total, turn) => total + turn.message.split(/\s+/).filter(Boolean).length, 0);
  const avgWords = candidateTurns.length > 0 ? words / candidateTurns.length : 0;

  const keywordHits = interview.jobDescription
    .toLowerCase()
    .split(/[^a-z0-9+]+/)
    .filter((token) => token.length > 4);
  const uniqueKeywords = [...new Set(keywordHits)];
  const matched = uniqueKeywords.filter((keyword) =>
    interview.transcript.some((turn) => turn.role !== 'assistant' && turn.message.toLowerCase().includes(keyword)),
  ).length;
  const coverage = uniqueKeywords.length > 0 ? matched / uniqueKeywords.length : 0;

  const depth = Math.min(1, avgWords / 40);
  const engagement = Math.min(1, candidateTurns.length / 8);
  const overallScore = Math.round((coverage * 0.5 + depth * 0.3 + engagement * 0.2) * 100);

  return {
    decision: overallScore >= 70 ? 'pass' : overallScore >= 50 ? 'borderline' : 'fail',
    overallScore,
    dimensions: [
      { name: 'Role knowledge', score: Math.round(coverage * 100), rationale: 'Keyword overlap with the job description.' },
      { name: 'Relevant experience', score: Math.round(depth * 100), rationale: 'Depth of answers by average length.' },
      { name: 'Communication', score: Math.round(engagement * 100), rationale: 'Engagement by number of substantive answers.' },
    ],
    strengths: [],
    concerns: [
      'Automatic evaluator was unavailable; this score is a rough heuristic.',
      reason,
    ],
    summary: `Heuristic fallback scorecard (${overallScore}/100). The evaluator agent did not return usable JSON.`,
    recommendedNextStep: 'Review the transcript manually before deciding.',
    source: 'heuristic-fallback',
  };
}

/**
 * Score an interview by asking the dedicated evaluator agent. Falls back to a
 * heuristic scorecard if the agent cannot be reached.
 */
export async function evaluateInterview(interview: InterviewRecord): Promise<Scorecard> {
  const evaluator = db.getAgent('evaluator');
  if (!evaluator) return heuristicScorecard(interview, 'No evaluator agent is provisioned.');

  try {
    const prompt = buildEvaluatorMessage(interview);
    const channelUserId = uuidV5(AGENTSCRUT_NAMESPACE, `evaluator:${interview.id}`);

    const sent = await bimpe.conversations.send(evaluator.agentId, {
      message: prompt,
      role: 'user',
      channel_type: 'webchat',
      channel_user_id: channelUserId,
      is_test_channel: true,
    });

    // Some deployments answer synchronously; prefer that path when available.
    if (sent.role === 'assistant' && sent.message) {
      const direct = parseScorecard(sent.message);
      if (direct) return direct;
    }

    const conversationId = await resolveConversation(evaluator.agentId, channelUserId);
    if (!conversationId) return heuristicScorecard(interview, 'Evaluator conversation could not be located.');

    const reply = await waitForAssistantReply(evaluator.agentId, conversationId, sent.created_at);
    if (!reply) return heuristicScorecard(interview, 'Evaluator agent did not reply in time.');

    const scorecard = parseScorecard(reply);
    if (!scorecard) return heuristicScorecard(interview, 'Evaluator reply was not valid JSON.');
    return scorecard;
  } catch (error) {
    logger.warn('Evaluator agent failed; using heuristic fallback', {
      interviewId: interview.id,
      error: describeError(error),
    });
    return heuristicScorecard(interview, describeError(error));
  }
}
