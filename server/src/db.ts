import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { env } from './env.js';
import { logger } from './logger.js';
import type {
  InterviewEvent,
  InterviewRecord,
  PhoneNumberRecord,
  ProvisionedAgent,
} from './types.js';

interface DatabaseShape {
  version: 1;
  agents: Record<string, ProvisionedAgent>;
  phoneNumbers: PhoneNumberRecord[];
  interviews: Record<string, InterviewRecord>;
  events: InterviewEvent[];
}

const EMPTY: DatabaseShape = {
  version: 1,
  agents: {},
  phoneNumbers: [],
  interviews: {},
  events: [],
};

const dataDir = isAbsolute(env.DATA_DIR) ? env.DATA_DIR : resolve(process.cwd(), env.DATA_DIR);
const dbPath = join(dataDir, 'db.json');

class Database {
  private state: DatabaseShape = structuredClone(EMPTY);

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(dbPath)) {
        const raw = readFileSync(dbPath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<DatabaseShape>;
        this.state = { ...structuredClone(EMPTY), ...parsed };
        this.normalize();
      }
    } catch (error) {
      logger.warn('Could not read database file; starting fresh', {
        path: dbPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Bring records written by older versions in line with the current shape. */
  private normalize(): void {
    for (const record of Object.values(this.state.interviews)) {
      if (typeof record.summary !== 'string') record.summary = null;
      if (typeof record.summaryError !== 'string') record.summaryError = null;
      // WhatsApp handoff fields were removed; drop them so they never resurface.
      const writable = record as unknown as Record<string, unknown>;
      delete writable.handoffStatus;
      delete writable.handoffError;
      delete writable.handoffMessage;
      delete writable.reviewerWhatsapp;
    }
  }

  persist(): void {
    try {
      mkdirSync(dirname(dbPath), { recursive: true });
      const tmp = `${dbPath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
      renameSync(tmp, dbPath);
    } catch (error) {
      logger.error('Failed to persist database', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /* --------------------------------- agents -------------------------------- */

  getAgent(role: string): ProvisionedAgent | null {
    return this.state.agents[role] ?? null;
  }

  setAgent(agent: ProvisionedAgent): void {
    this.state.agents[agent.role] = agent;
    this.persist();
  }

  /* ------------------------------ phone numbers ---------------------------- */

  listPhoneNumbers(): PhoneNumberRecord[] {
    return this.state.phoneNumbers;
  }

  upsertPhoneNumber(record: PhoneNumberRecord): void {
    const index = this.state.phoneNumbers.findIndex((item) => item.id === record.id);
    if (index === -1) this.state.phoneNumbers.push(record);
    else this.state.phoneNumbers[index] = record;
    this.persist();
  }

  /* ------------------------------- interviews ------------------------------ */

  listInterviews(): InterviewRecord[] {
    return Object.values(this.state.interviews).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  getInterview(id: string): InterviewRecord | null {
    return this.state.interviews[id] ?? null;
  }

  createInterview(record: InterviewRecord): InterviewRecord {
    this.state.interviews[record.id] = record;
    this.persist();
    return record;
  }

  updateInterview(id: string, patch: Partial<InterviewRecord>): InterviewRecord | null {
    const current = this.state.interviews[id];
    if (!current) return null;
    this.state.interviews[id] = { ...current, ...patch };
    this.persist();
    return this.state.interviews[id];
  }

  /* --------------------------------- events -------------------------------- */

  listEvents(interviewId: string, afterId?: string): InterviewEvent[] {
    const events = this.state.events.filter((event) => event.interviewId === interviewId);
    if (!afterId) return events;
    const index = events.findIndex((event) => event.id === afterId);
    return index === -1 ? events : events.slice(index + 1);
  }

  addEvent(interviewId: string, type: string, message: string, data?: Record<string, unknown>): InterviewEvent {
    const event: InterviewEvent = {
      id: randomUUID(),
      interviewId,
      type,
      message,
      data: data ?? null,
      createdAt: new Date().toISOString(),
    };
    this.state.events.push(event);
    // Keep the tail bounded; this is a demo store, not an audit log.
    if (this.state.events.length > 5000) this.state.events.splice(0, this.state.events.length - 5000);
    this.persist();
    return event;
  }
}

export const db = new Database();
export { dbPath };
