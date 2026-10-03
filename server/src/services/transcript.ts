import { bimpe } from '../bimpe.js';
import { logger } from '../logger.js';
import type { TranscriptTurn } from '../types.js';

/**
 * Transcript helpers. BimpeAI can surface a telephony call's turns in two
 * independent places — the call's `conversation_logs` and the matching
 * `telephony` conversation. These helpers normalise, merge, and de-duplicate
 * both so the pipeline works whichever one the platform populates (and the
 * moment call transcription is enabled).
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

interface RawTurn {
  id?: string | null;
  role?: string | null;
  message?: string | null;
  created_at?: string | null;
  createdAt?: string | null;
}

export function turnFromRaw(entry: RawTurn, fallbackId: string): TranscriptTurn {
  return {
    id: entry.id ?? fallbackId,
    role: normalizeRole(entry.role ?? 'user'),
    message: (entry.message ?? '').trim(),
    createdAt: entry.created_at ?? entry.createdAt ?? new Date().toISOString(),
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

/** Find the telephony conversation that belongs to a candidate phone number. */
export async function resolveTelephonyConversation(
  agentId: string,
  phone: string,
): Promise<string | null> {
  const queries = [
    { search: phone, limit: 50, sort: '-created_at' } as const,
    { limit: 100, sort: '-created_at' } as const,
  ];

  for (const query of queries) {
    try {
      const page = await bimpe.conversations.list(agentId, query);
      const telephony = page.data.filter((conversation) => conversation.channel_type === 'telephony');
      const match = telephony.find(
        (conversation) =>
          conversation.channel_user_id === phone ||
          (digits(conversation.channel_user_id) !== '' &&
            digits(conversation.channel_user_id) === digits(phone)),
      );
      if (match) return match.id;
    } catch (error) {
      logger.warn('Could not list telephony conversations', {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return null;
}

/** Read the persisted turns of a conversation, if any. */
export async function fetchConversationTurns(
  agentId: string,
  conversationId: string,
): Promise<TranscriptTurn[]> {
  try {
    const page = await bimpe.conversations.messages.list(agentId, conversationId, {
      limit: 100,
      sort: 'created_at',
    });
    return page.data
      .map((message, index) => turnFromRaw(message, `${conversationId}-${index}`))
      .filter((turn) => turn.message.length > 0);
  } catch (error) {
    logger.warn('Could not read conversation transcript', {
      conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
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
