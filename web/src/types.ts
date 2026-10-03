/* Mirror of the server domain types that the UI needs. */

export type InterviewStatus =
  | 'created'
  | 'provisioning'
  | 'ready'
  | 'calling'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'expired';

export interface TranscriptTurn {
  id: string;
  role: string;
  message: string;
  createdAt: string;
}

export interface ScoreDimension {
  name: string;
  score: number;
  rationale: string;
}

export interface Scorecard {
  decision: 'pass' | 'fail' | 'borderline';
  overallScore: number;
  dimensions: ScoreDimension[];
  strengths: string[];
  concerns: string[];
  summary: string;
  recommendedNextStep: string;
  source: 'evaluator-agent' | 'heuristic-fallback';
  raw?: string;
}

export interface InterviewRecord {
  id: string;
  jobTitle: string;
  jobDescription: string;
  seniority: string | null;
  keyRequirements: string[];
  candidateName: string;
  candidatePhone: string;
  passThreshold: number;
  status: InterviewStatus;
  agentId: string | null;
  workflowId: string | null;
  callId: string | null;
  callStatus: string | null;
  transcript: TranscriptTurn[];
  scorecard: Scorecard | null;
  summary: string | null;
  summaryError: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
}

export interface InterviewEvent {
  id: string;
  interviewId: string;
  type: string;
  message: string;
  data: Record<string, unknown> | null;
  createdAt: string;
}

export interface ProvisionedAgent {
  role: string;
  agentId: string;
  workflowId: string;
  name: string;
  createdAt: string;
}

export interface PhoneNumberRecord {
  id: string;
  e164: string;
  agentId: string | null;
  label: string | null;
  updatedAt: string;
}

export interface SystemStatus {
  voiceProvider: string;
  config: {
    maxSeconds: number;
    passThreshold: number;
    agentNames: { interviewer: string; evaluator: string; assistant: string };
    ownerWhatsapp: string | null;
  };
  agents: {
    interviewer: ProvisionedAgent | null;
    evaluator: ProvisionedAgent | null;
    assistant: ProvisionedAgent | null;
  };
  channels: Array<{ id: string; type: string; name: string; status: string; is_connected: boolean }>;
  assistantChannels: Array<{ id: string; type: string; name: string; status: string; is_connected: boolean }>;
  warnings: string[];
  phoneNumbers: PhoneNumberRecord[];
}

export interface ProvisioningSummary {
  ready: boolean;
  agents: {
    interviewer: ProvisionedAgent | null;
    evaluator: ProvisionedAgent | null;
    assistant: ProvisionedAgent | null;
  };
  phoneNumber: PhoneNumberRecord | null;
  phoneRequestPending: boolean;
  notes: string[];
}

export interface CreateInterviewInput {
  jobTitle: string;
  jobDescription: string;
  seniority?: string;
  keyRequirements?: string[];
  candidateName: string;
  candidatePhone: string;
  passThreshold?: number;
}

export const INTERVIEW_EVENT_TYPES = [
  'created',
  'notice',
  'provisioning',
  'calling',
  'call_started',
  'in_progress',
  'transcript',
  'call_ended',
  'cap_reached',
  'ring_timeout',
  'scorecard',
  'scorecard_skipped',
  'transcript_missing',
  'summary_sending',
  'summary_sent',
  'summary_failed',
  'completed',
  'error',
] as const;
