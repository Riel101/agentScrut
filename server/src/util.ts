import { createHash } from 'node:crypto';

/**
 * Deterministic UUIDv5 from a namespace + name. Used so the same logical
 * conversation always maps to the same UUID (required by webchat channels).
 */
export function uuidV5(namespace: string, name: string): string {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(namespaceBytes).update(Buffer.from(name, 'utf8')).digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Stable namespace for AgentScrut's evaluator conversations. */
export const AGENTSCRUT_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
