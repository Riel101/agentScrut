import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));

// Load the first .env files we can find: the server workspace, then the repo root.
const candidates = [
  join(process.cwd(), '.env'),
  resolve(here, '../../.env'),
  resolve(here, '../../../.env'),
];
for (const path of candidates) {
  if (existsSync(path)) loadEnv({ path });
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  BIMPE_API_KEY: z.string().min(1, 'BIMPE_API_KEY is required (see .env.example)'),
  BIMPE_BASE_URL: z.string().url().default('https://api.bimpe.ai'),

  KROS_API_KEY: z.string().optional(),
  KROS_BASE_URL: z.string().url().default('https://api.krosai.com/api/v1'),

  PORT: z.coerce.number().int().positive().default(8787),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:8787'),

  INTERVIEW_MAX_SECONDS: z.coerce.number().int().positive().default(300),
  INTERVIEW_PASS_THRESHOLD: z.coerce.number().min(0).max(100).default(70),
  INTERVIEW_TRANSCRIPT_GRACE_SECONDS: z.coerce.number().int().min(0).max(300).default(45),
  // How long to let the destination ring before treating the call as no-answer
  // and releasing the single-call guard. Set 0 to wait until INTERVIEW_MAX_SECONDS.
  INTERVIEW_RING_TIMEOUT_SECONDS: z.coerce.number().int().min(0).max(600).default(75),
  VOICE_PROVIDER: z.enum(['bimpe', 'kros']).default('bimpe'),

  INTERVIEWER_AGENT_NAME: z.string().min(1).default('Interview Copilot'),
  EVALUATOR_AGENT_NAME: z.string().min(1).default('Interview Evaluator'),
  ASSISTANT_AGENT_NAME: z.string().min(1).default('Hiring Assistant'),

  // Owner (human reviewer) WhatsApp number the Hiring Assistant reports to.
  // E.164, e.g. +2348012345678. Leave empty to disable outbound summaries.
  OWNER_WHATSAPP: z
    .string()
    .trim()
    .default('')
    .refine((value) => value === '' || /^\+[1-9]\d{6,14}$/.test(value), {
      message: 'OWNER_WHATSAPP must be empty or an E.164 number, e.g. +2348012345678',
    }),

  PHONE_BUSINESS_NAME: z.string().min(1).default('AgentScrut Demo'),
  PHONE_INTENDED_USE: z.string().min(1).default('Outbound candidate screening interviews'),
  PHONE_REGION: z.enum(['us', 'uk', 'eu', 'ng']).default('ng'),
  PHONE_OUTBOUND_MINUTES: z.coerce.number().int().positive().default(120),

  // Outbound WhatsApp uses the agent's BimpeAI *test* channel by default. The
  // test channel only responds once the owner has texted first (opt-in plus
  // WhatsApp's session window). Set false for a connected production channel.
  WHATSAPP_TEST_CHANNEL: z
    .string()
    .default('true')
    .transform((value) => value.toLowerCase() !== 'false'),

  DATA_DIR: z.string().default('data'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === 'production';
