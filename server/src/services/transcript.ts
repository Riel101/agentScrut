import { bimpe } from '../bimpe.js';
import { logger } from '../logger.js';
import type { TranscriptTurn } from '../types.js';

/**
 * Transcript helpers. BimpeAI can surface a telephony call's turns in two
 * independent places — the call's `conversation_logs` and the matching
 * conversation's messages. These helpers normalise, merge, and de-duplicate
 * every source so the pipeline works whichever one the platform populates (and
 * the moment call transcription is enabled).
 */

const ASSISTANT_LABELS = new Set([
  'interviewer',
  'interview copilot',
  'agent',
  'ai',
  'assistant',
  'bot',
  'recruiter',
  'system',
]);

const USER_LABELS = new Set([
  'candidate',
  'user',
  'you',
  'me',
  'applicant',
  'customer',
  'human',
  'phone user',
]);

function labelKey(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Resolve a known speaker label to a role, or null if it is not recognised. */
export function knownSpeaker(label: string): 'assistant' | 'user' | null {
  const key = labelKey(label);
  if (ASSISTANT_LABELS.has(key)) return 'assistant';
  if (USER_LABELS.has(key)) return 'user';
  return null;
}

/** Map a raw role/speaker string to our normalised roles where possible. */
export function normalizeRole(role: string): string {
  return knownSpeaker(role) ?? (role.trim().toLowerCase() || 'user');
}

/** A turn in whatever shape the platform returns it (keys vary by channel). */
interface RawTurn {
  id?: unknown;
  message_id?: unknown;
  role?: unknown;
  speaker?: unknown;
  sender?: unknown;
  from?: unknown;
  message?: unknown;
  content?: unknown;
  text?: unknown;
  body?: unknown;
  transcript?: unknown;
  created_at?: unknown;
  createdAt?: unknown;
  timestamp?: unknown;
  time?: unknown;
}

const asText = (value: unknown): string =>
  typeof value === 'string' ? value : value == null ? '' : String(value);

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = asText(value).trim();
    if (text) return text;
  }
  return '';
}

export function turnFromRaw(entry: RawTurn, fallbackId: string): TranscriptTurn {
  return {
    id: firstText(entry.id, entry.message_id) || fallbackId,
    role: normalizeRole(firstText(entry.role, entry.speaker, entry.sender, entry.from) || 'user'),
    message: firstText(entry.message, entry.content, entry.text, entry.body, entry.transcript),
    createdAt:
      firstText(entry.created_at, entry.createdAt, entry.timestamp, entry.time) ||
      new Date().toISOString(),
  };
}

/** De-duplicate turns by id (first wins) and order them chronologically. */
export function mergeTurns(
  ...lists: ReadonlyArray<ReadonlyArray<TranscriptTurn>>
): TranscriptTurn[] {
  const byId = new Map<string, TranscriptTurn>();
  for (const list of lists) {
    for (const turn of list) {
      if (!turn.message) continue;
      if (!byId.has(turn.id)) byId.set(turn.id, turn);
    }
  }
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

const digits = (value: string | null | undefined): string => (value ?? '').replace(/\D/g, '');

interface ConversationCandidate {
  id: string;
  channelType: string;
  userId: string | null;
}

async function listCandidates(
  agentId: string,
  query: Record<string, string | number | boolean>,
): Promise<ConversationCandidate[]> {
  try {
    const page = await bimpe.conversations.list(agentId, query);
    return page.data.map((conversation) => ({
      id: conversation.id,
      channelType: conversation.channel_type,
      userId: conversation.channel_user_id,
    }));
  } catch (error) {
    logger.warn('Could not list conversations', {
      agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Find every conversation that could hold a call's turns for a candidate phone
 * number: `telephony`/`test_telephony` conversations addressed to that number,
 * plus any `voice` conversation whose user id digit-matches (some builds log
 * calls there). Ordered most-likely first.
 */
export async function resolveCallConversations(agentId: string, phone: string): Promise<string[]> {
  const wanted = digits(phone);
  const queries: Array<Record<string, string | number | boolean>> = [
    { channel: 'telephony', limit: 50, sort: '-created_at' },
    { channel: 'test_telephony', limit: 50, sort: '-created_at' },
    { search: phone, limit: 50, sort: '-created_at' },
    { limit: 100, sort: '-created_at' },
  ];

  const seen = new Map<string, ConversationCandidate>();
  for (const query of queries) {
    for (const candidate of await listCandidates(agentId, query)) {
      if (!seen.has(candidate.id)) seen.set(candidate.id, candidate);
    }
  }

  const matches = (candidate: ConversationCandidate): boolean =>
    wanted !== '' && digits(candidate.userId) !== '' && digits(candidate.userId) === wanted;

  const telephony: string[] = [];
  const voice: string[] = [];
  for (const candidate of seen.values()) {
    if (!matches(candidate)) continue;
    if (candidate.channelType === 'telephony' || candidate.channelType === 'test_telephony') {
      telephony.push(candidate.id);
    } else if (candidate.channelType === 'voice') {
      voice.push(candidate.id);
    }
  }
  return [...telephony, ...voice];
}

/** Read the persisted turns of a conversation, if any. */
export async function fetchConversationTurns(
  agentId: string,
  conversationId: string,
): Promise<TranscriptTurn[]> {
  // Query twice with opposite sort orders and merge: if the platform ever
  // ignores one variant we still capture the turns.
  const variants = [{ limit: 100, sort: 'created_at' }, { limit: 100, sort: '-created_at' }];
  const lists: TranscriptTurn[][] = [];
  for (const [index, query] of variants.entries()) {
    try {
      const page = await bimpe.conversations.messages.list(agentId, conversationId, query);
      lists.push(
        page.data
          .map((message, messageIndex) =>
            turnFromRaw(message, `${conversationId}-v${index}-${messageIndex}`),
          )
          .filter((turn) => turn.message.length > 0),
      );
    } catch (error) {
      logger.warn('Could not read conversation transcript', {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return mergeTurns(...lists);
}

/**
 * Parse a pasted transcript into turns. Accepts `Speaker: text` lines (with
 * optional `[timestamp]` or `**bold**` labels) and folds unlabelled lines into
 * the previous turn. Unknown speaker names are assigned in order of appearance
 * (first speaker = interviewer) so arbitrary formats still work.
 */
export function parseTranscriptText(
  text: string,
  options: { candidateName?: string } = {},
): TranscriptTurn[] {
  const now = Date.now();
  const turns: TranscriptTurn[] = [];
  const unknownRoles = new Map<string, string>();
  const candidateKey = options.candidateName ? labelKey(options.candidateName) : null;

  const speakerPattern =
    /^\s*(?:\[[^\]]*\]\s*)?(?:\*\*)?([A-Za-z][A-Za-z0-9 .'_-]{0,30}?)(?:\*\*)?\s*[:\-–]\s*(?:\*\*)?\s*(.*)$/;

  const isLikelyLabel = (label: string, body: string): boolean => {
    if (!body) return false;
    if (knownSpeaker(label)) return true;
    if (candidateKey && labelKey(label) === candidateKey) return true;
    const words = label.trim().split(/\s+/);
    return words.length <= 3 && label.trim().length <= 25;
  };

  const resolveUnknown = (label: string): string => {
    const key = labelKey(label);
    if (candidateKey && key === candidateKey) return 'user';
    const existing = unknownRoles.get(key);
    if (existing) return existing;
    const role = unknownRoles.size === 0 ? 'assistant' : 'user';
    unknownRoles.set(key, role);
    return role;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = speakerPattern.exec(line);
    if (match && isLikelyLabel(match[1], match[2].trim())) {
      const label = match[1].trim();
      turns.push({
        id: `import-${turns.length}`,
        role: knownSpeaker(label) ?? resolveUnknown(label),
        message: match[2].trim(),
        createdAt: new Date(now + turns.length * 1000).toISOString(),
      });
      continue;
    }

    const previous = turns[turns.length - 1];
    if (previous) previous.message = `${previous.message} ${line}`.trim();
    else {
      turns.push({
        id: `import-${turns.length}`,
        role: 'user',
        message: line,
        createdAt: new Date(now).toISOString(),
      });
    }
  }

  return turns.filter((turn) => turn.message.length > 0);
}
