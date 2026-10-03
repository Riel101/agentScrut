import { z } from 'zod';

/* ---------------------------------- domain --------------------------------- */

export type AgentRole = 'interviewer' | 'evaluator' | 'assistant';

export interface ProvisionedAgent {
  role: AgentRole;
  agentId: string;
  workflowId: string;
  name: string;
  createdAt: string;
}

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
  /** How the scorecard was produced. */
  source: 'evaluator-agent' | 'heuristic-fallback';
  /** Raw model text, kept for debugging. */
  raw?: string;
}

export type InterviewStatus =
  | 'created'
  | 'provisioning'
  | 'ready'
  | 'calling'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'expired';

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

  /** Short performance summary sent to the owner by the Hiring Assistant. */
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

export interface PhoneNumberRecord {
  id: string;
  e164: string;
  agentId: string | null;
  label: string | null;
  updatedAt: string;
}

/* ---------------------------------- input ---------------------------------- */

const e164 = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/, 'Must be an E.164 phone number, e.g. +2348012345678');

export const createInterviewSchema = z.object({
  jobTitle: z.string().trim().min(2, 'Job title is too short').max(160),
  jobDescription: z.string().trim().min(20, 'Add a fuller job description (20+ characters)').max(8000),
  seniority: z.string().trim().max(80).optional(),
  keyRequirements: z.array(z.string().trim().min(1)).max(20).optional(),
  candidateName: z.string().trim().min(1, 'Candidate name is required').max(120),
  candidatePhone: e164,
  passThreshold: z.number().min(0).max(100).optional(),
});

export type CreateInterviewInput = z.infer<typeof createInterviewSchema>;

export const importTranscriptSchema = z
  .object({
    transcript: z.string().trim().min(1).max(100_000).optional(),
    turns: z
      .array(
        z.object({
          role: z.string().trim().min(1).max(40),
          message: z.string().trim().min(1).max(20_000),
          createdAt: z.string().trim().optional(),
        }),
      )
      .min(1)
      .max(2_000)
      .optional(),
    evaluate: z.boolean().optional(),
  })
  .refine((value) => Boolean(value.transcript || value.turns), {
    message: 'Provide transcript text or turns',
  });

export type ImportTranscriptInput = z.infer<typeof importTranscriptSchema>;

export interface CreateInterviewResult {
  interview: InterviewRecord;
}

export interface ProvisioningSummary {
  ready: boolean;
  agents: Record<AgentRole, ProvisionedAgent | null>;
  phoneNumber: PhoneNumberRecord | null;
  phoneRequestPending: boolean;
  notes: string[];
}
