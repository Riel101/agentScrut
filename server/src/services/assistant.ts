import type { KnowledgeBaseItem } from '@bimpeai/sdk';
import { bimpe, describeError } from '../bimpe.js';
import { db } from '../db.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { buildAssistantSummaryMessage } from '../prompts.js';
import type { InterviewRecord } from '../types.js';

// BimpeAI caps `text` knowledge-base content at 2500 characters, so the
// assistant gets one compact index document and one dossier document per
// candidate (each clipped well below the cap).
const KB_INDEX_NAME = 'Candidate Index';
const KB_INDEX_DESCRIPTION = 'Compact list of every interviewed candidate with score and a one-line gist.';
const KB_DOSSIER_PREFIX = 'Candidate: ';
const KB_CONTENT_LIMIT = 2_400;
const LEGACY_KB_NAME = 'Candidate Dossiers';

export interface AssistantNotifyResult {
  summary: string;
  sent: boolean;
  error: string | null;
}

function fallbackLine(interview: InterviewRecord): string {
  if (interview.status === 'failed') {
    return interview.error ?? 'The call did not complete, so there is no score.';
  }
  if (!interview.scorecard) {
    return 'The interview finished but no scorecard was produced.';
  }
  return '';
}

/** Short, WhatsApp-ready performance summary for the owner. */
export function composeSummary(interview: InterviewRecord): string {
  return buildAssistantSummaryMessage(interview, fallbackLine(interview));
}

/** Full dossier text used to keep the assistant's knowledge base current. */
export function candidateDossier(interview: InterviewRecord): string {
  const scorecard = interview.scorecard;
  const lines = [
    `CANDIDATE: ${interview.candidateName}`,
    `Role: ${interview.jobTitle}${interview.seniority ? ` (${interview.seniority})` : ''}`,
    `Phone: ${interview.candidatePhone}`,
    `Interviewed: ${interview.endedAt ?? interview.createdAt}`,
    `Call status: ${interview.status}${interview.callStatus ? ` (${interview.callStatus})` : ''}`,
  ];

  if (scorecard) {
    lines.push(`Overall score: ${scorecard.overallScore}/100 (${scorecard.decision})`);
    if (scorecard.dimensions.length) {
      lines.push(
        `Dimensions: ${scorecard.dimensions
          .map((dimension) => `${dimension.name} ${dimension.score}/100 — ${dimension.rationale}`)
          .join('; ')}`,
      );
    }
    if (scorecard.strengths.length) lines.push(`Strengths: ${scorecard.strengths.join('; ')}`);
    if (scorecard.concerns.length) lines.push(`Concerns: ${scorecard.concerns.join('; ')}`);
    if (scorecard.summary) lines.push(`Summary: ${scorecard.summary}`);
    if (scorecard.recommendedNextStep) lines.push(`Recommended next step: ${scorecard.recommendedNextStep}`);
  } else {
    lines.push('Overall score: not scored');
  }

  if (interview.transcript.length > 0) {
    lines.push('Transcript:');
    for (const turn of interview.transcript) {
      const speaker = turn.role === 'assistant' ? 'Interviewer' : 'Candidate';
      lines.push(`  ${speaker}: ${turn.message}`);
    }
  } else {
    lines.push('Transcript: (not available)');
  }

  return lines.join('\n');
}

/** Rebuild the assistant's candidate knowledge base from the store. */
export async function refreshKnowledgeBase(): Promise<boolean> {
  const assistant = db.getAgent('assistant');
  if (!assistant) return false;

  const interviews = db
    .listInterviews()
    .filter((interview) => interview.status === 'completed' || interview.status === 'failed');

  try {
    const existing = await bimpe.agents.knowledgeBases.list(assistant.agentId);
    const byName = new Map(existing.map((item) => [item.name, item] as const));

    const indexContent = clip(
      interviews.length
        ? interviews.map(indexLine).join('\n')
        : 'No interviews have been completed yet.',
    );
    await upsertKnowledgeBase(assistant.agentId, byName, KB_INDEX_NAME, KB_INDEX_DESCRIPTION, indexContent);

    for (const interview of interviews) {
      await upsertKnowledgeBase(
        assistant.agentId,
        byName,
        dossierKbName(interview),
        `Full dossier for ${interview.candidateName} (${interview.jobTitle}).`,
        clip(candidateDossier(interview)),
      );
    }

    // Drop the pre-index single-document KB if it is still attached.
    const legacy = byName.get(LEGACY_KB_NAME);
    if (legacy) {
      try {
        await bimpe.agents.knowledgeBases.delete(assistant.agentId, legacy.id);
      } catch {
        /* best effort */
      }
    }

    return true;
  } catch (error) {
    logger.warn('Could not refresh the candidate knowledge base', { error: describeError(error) });
    return false;
  }
}

function clip(text: string, max = KB_CONTENT_LIMIT): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 24)}\n…[truncated]`;
}

function dossierKbName(interview: InterviewRecord): string {
  return `${KB_DOSSIER_PREFIX}${interview.candidateName} [${interview.id.slice(0, 8)}]`;
}

function indexLine(interview: InterviewRecord): string {
  const scorecard = interview.scorecard;
  const score = scorecard ? `${scorecard.overallScore}/100 (${scorecard.decision})` : 'not scored';
  const gist = (scorecard?.summary ?? interview.summary ?? '').replace(/\s+/g, ' ').trim();
  const short = gist.length > 140 ? `${gist.slice(0, 137)}…` : gist;
  return `• ${interview.candidateName} · ${interview.jobTitle} · ${score}${short ? ` — ${short}` : ''}`;
}

async function upsertKnowledgeBase(
  agentId: string,
  byName: Map<string, KnowledgeBaseItem>,
  name: string,
  description: string,
  content: string,
): Promise<void> {
  const existing = byName.get(name);
  try {
    if (existing) {
      const updated = await bimpe.agents.knowledgeBases.update(agentId, existing.id, { content, description });
      byName.set(name, updated);
    } else {
      const created = await bimpe.agents.knowledgeBases.create(agentId, {
        type: 'text',
        name,
        description,
        content,
      });
      byName.set(name, created);
    }
  } catch (error) {
    logger.warn('Could not upsert knowledge base document', { name, error: describeError(error) });
  }
}

/**
 * Compose a short performance summary for a finished interview, send it to the
 * owner from the Hiring Assistant's WhatsApp channel, and refresh the assistant's
 * candidate knowledge base. The summary is always returned so it can be stored
 * even when the WhatsApp send fails.
 */
export async function notifyInterview(interview: InterviewRecord): Promise<AssistantNotifyResult> {
  const summary = composeSummary(interview);
  const assistant = db.getAgent('assistant');

  let sent = false;
  let error: string | null = null;

  if (!assistant) {
    error = 'No assistant agent is provisioned.';
  } else if (!env.OWNER_WHATSAPP) {
    error = 'OWNER_WHATSAPP is not configured.';
  } else {
    try {
      await bimpe.conversations.send(assistant.agentId, {
        message: summary,
        role: 'assistant',
        channel_type: 'whatsapp',
        channel_user_id: env.OWNER_WHATSAPP,
        is_test_channel: env.WHATSAPP_TEST_CHANNEL,
      });
      sent = true;
      logger.info('Sent interview summary to owner', {
        interviewId: interview.id,
        owner: env.OWNER_WHATSAPP,
      });
    } catch (sendError) {
      error = describeError(sendError);
      logger.warn('Interview summary send failed', { interviewId: interview.id, error });
    }
  }

  // Keep the assistant current regardless of whether the WhatsApp send worked.
  await refreshKnowledgeBase();

  return { summary, sent, error };
}
