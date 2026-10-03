import { BimpeAI } from '@bimpeai/sdk';
import { env } from './env.js';
import { logger } from './logger.js';

/**
 * Shared BimpeAI Agent Console client. The SDK is a zero-dependency HTTP client,
 * so one instance is safe to reuse across the process.
 */
export const bimpe = new BimpeAI({
  apiKey: env.BIMPE_API_KEY,
  baseUrl: env.BIMPE_BASE_URL,
  logger: logger.sdk,
  defaultHeaders: {
    'X-Client': 'agentscrut-server',
  },
});

/** Human-readable description of an SDK error, including request id when present. */
export function describeError(error: unknown): string {
  if (error && typeof error === 'object' && 'requestId' in error) {
    const candidate = error as { message?: string; status?: number; requestId?: string | null };
    const parts = [candidate.message ?? 'Request failed'];
    if (candidate.status) parts.push(`status=${candidate.status}`);
    if (candidate.requestId) parts.push(`requestId=${candidate.requestId}`);
    return parts.join(' · ');
  }
  return error instanceof Error ? error.message : String(error);
}
