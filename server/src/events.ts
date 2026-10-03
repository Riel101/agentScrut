import { EventEmitter } from 'node:events';
import { db } from './db.js';
import type { InterviewEvent } from './types.js';

/**
 * In-process pub/sub for interview progress. Events are also persisted so a
 * client that connects late can replay everything that happened.
 */
class InterviewBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
  }

  publish(interviewId: string, type: string, message: string, data?: Record<string, unknown>): InterviewEvent {
    const event = db.addEvent(interviewId, type, message, data);
    this.emit(interviewId, event);
    this.emit('*', event);
    return event;
  }

  subscribe(interviewId: string, listener: (event: InterviewEvent) => void): () => void {
    this.on(interviewId, listener);
    return () => this.off(interviewId, listener);
  }
}

export const interviewBus = new InterviewBus();
