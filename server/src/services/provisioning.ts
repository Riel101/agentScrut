import type { Agent, Workflow } from '@bimpeai/sdk';
import { bimpe, describeError } from '../bimpe.js';
import { db } from '../db.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { ASSISTANT_SYSTEM_PROMPT, EVALUATOR_SYSTEM_PROMPT, buildInterviewerPrompt } from '../prompts.js';
import type { AgentRole, PhoneNumberRecord, ProvisioningSummary, ProvisionedAgent } from '../types.js';

const PROVISION_TAG = 'agentscrut';

/** Find an owned workflow by exact name (case-insensitive). */
async function findWorkflowByName(name: string): Promise<Workflow | null> {
  const page = await bimpe.workflows.list({ scope: 'owned', search: name, limit: 100 });
  return page.data.find((workflow) => workflow.name.toLowerCase() === name.toLowerCase()) ?? null;
}

/** Find an agent by exact name (case-insensitive). */
async function findAgentByName(name: string): Promise<Agent | null> {
  const page = await bimpe.agents.list({ search: name, limit: 100 });
  return page.data.find((agent) => agent.name.toLowerCase() === name.toLowerCase()) ?? null;
}

async function isAgentAlive(agentId: string): Promise<boolean> {
  try {
    await bimpe.agents.retrieve(agentId);
    return true;
  } catch {
    return false;
  }
}

/** Keep the assistant workflow prompt in sync with the code (best effort). */
async function syncAssistantPrompt(workflowId: string): Promise<void> {
  try {
    await bimpe.workflows.update(workflowId, { system_prompt: ASSISTANT_SYSTEM_PROMPT });
  } catch (error) {
    logger.warn('Could not refresh the hiring assistant prompt', {
      workflowId,
      error: describeError(error),
    });
  }
}

async function ensureInterviewer(): Promise<ProvisionedAgent> {
  const cached = db.getAgent('interviewer');
  if (cached && (await isAgentAlive(cached.agentId))) return cached;

  const existing = await findAgentByName(env.INTERVIEWER_AGENT_NAME);
  if (existing && existing.workflow_id) {
    const record: ProvisionedAgent = {
      role: 'interviewer',
      agentId: existing.id,
      workflowId: existing.workflow_id,
      name: existing.name,
      createdAt: existing.created_at,
    };
    db.setAgent(record);
    return record;
  }

  const workflow =
    (await findWorkflowByName(`${env.INTERVIEWER_AGENT_NAME} workflow`)) ??
    (await bimpe.workflows.create({
      name: `${env.INTERVIEWER_AGENT_NAME} workflow`,
      description: 'Voice screening interviewer. The system prompt is specialised per job description.',
      system_prompt: buildInterviewerPrompt(
        {
          jobTitle: 'the advertised role',
          jobDescription: '(Job description is injected per interview before the call.)',
          seniority: null,
          keyRequirements: [],
          candidateName: 'Alex',
        },
        { agentName: env.INTERVIEWER_AGENT_NAME, maxSeconds: env.INTERVIEW_MAX_SECONDS },
      ),
      tags: [PROVISION_TAG],
      channels: ['telephony'],
    }));

  const agent = await bimpe.agents.create({
    workflow_id: workflow.id,
    name: env.INTERVIEWER_AGENT_NAME,
    description: 'Conducts short AI phone-screen interviews and hands qualified candidates to a human.',
    persona: 'professional',
    language: 'en',
    business_name: env.PHONE_BUSINESS_NAME,
  });

  const record: ProvisionedAgent = {
    role: 'interviewer',
    agentId: agent.id,
    workflowId: workflow.id,
    name: agent.name,
    createdAt: agent.created_at,
  };
  db.setAgent(record);
  logger.info('Provisioned interviewer agent', { agentId: agent.id, workflowId: workflow.id });
  return record;
}

async function ensureEvaluator(): Promise<ProvisionedAgent> {
  const cached = db.getAgent('evaluator');
  if (cached && (await isAgentAlive(cached.agentId))) return cached;

  const existing = await findAgentByName(env.EVALUATOR_AGENT_NAME);
  if (existing && existing.workflow_id) {
    const record: ProvisionedAgent = {
      role: 'evaluator',
      agentId: existing.id,
      workflowId: existing.workflow_id,
      name: existing.name,
      createdAt: existing.created_at,
    };
    db.setAgent(record);
    return record;
  }

  const workflow =
    (await findWorkflowByName(`${env.EVALUATOR_AGENT_NAME} workflow`)) ??
    (await bimpe.workflows.create({
      name: `${env.EVALUATOR_AGENT_NAME} workflow`,
      description: 'Scores interview transcripts against a role and returns a JSON scorecard.',
      system_prompt: EVALUATOR_SYSTEM_PROMPT,
      tags: [PROVISION_TAG],
    }));

  const agent = await bimpe.agents.create({
    workflow_id: workflow.id,
    name: env.EVALUATOR_AGENT_NAME,
    description: 'Reads interview transcripts and returns a structured hiring scorecard.',
    persona: 'concise',
    language: 'en',
  });

  const record: ProvisionedAgent = {
    role: 'evaluator',
    agentId: agent.id,
    workflowId: workflow.id,
    name: agent.name,
    createdAt: agent.created_at,
  };
  db.setAgent(record);
  logger.info('Provisioned evaluator agent', { agentId: agent.id, workflowId: workflow.id });
  return record;
}

async function ensureAssistant(): Promise<ProvisionedAgent> {
  const cached = db.getAgent('assistant');
  if (cached && (await isAgentAlive(cached.agentId))) {
    await syncAssistantPrompt(cached.workflowId);
    return cached;
  }

  const existing = await findAgentByName(env.ASSISTANT_AGENT_NAME);
  if (existing && existing.workflow_id) {
    const record: ProvisionedAgent = {
      role: 'assistant',
      agentId: existing.id,
      workflowId: existing.workflow_id,
      name: existing.name,
      createdAt: existing.created_at,
    };
    db.setAgent(record);
    await syncAssistantPrompt(record.workflowId);
    return record;
  }

  const workflow =
    (await findWorkflowByName(`${env.ASSISTANT_AGENT_NAME} workflow`)) ??
    (await bimpe.workflows.create({
      name: `${env.ASSISTANT_AGENT_NAME} workflow`,
      description: 'WhatsApp hiring assistant that reports candidate performance and answers the owner.',
      system_prompt: ASSISTANT_SYSTEM_PROMPT,
      tags: [PROVISION_TAG],
      channels: ['whatsapp'],
    }));

  const agent = await bimpe.agents.create({
    workflow_id: workflow.id,
    name: env.ASSISTANT_AGENT_NAME,
    description: 'Reports candidate performance and answers the hiring owner\u2019s questions over WhatsApp.',
    persona: 'concise',
    language: 'en',
    business_name: env.PHONE_BUSINESS_NAME,
  });

  const record: ProvisionedAgent = {
    role: 'assistant',
    agentId: agent.id,
    workflowId: workflow.id,
    name: agent.name,
    createdAt: agent.created_at,
  };
  db.setAgent(record);
  logger.info('Provisioned hiring assistant agent', { agentId: agent.id, workflowId: workflow.id });
  return record;
}

export interface PhoneProvisionResult {
  phoneNumber: PhoneNumberRecord | null;
  requestPending: boolean;
  note: string | null;
}

/**
 * Make sure a telephony number is linked to the interviewer agent. If none exists
 * and none is available to claim, file a provisioning request (fulfilled by
 * BimpeAI, which is asynchronous).
 */
export async function ensurePhoneNumber(agentId: string): Promise<PhoneProvisionResult> {
  const numbers = await bimpe.phoneNumbers.list({ limit: 100 });

  const linked = numbers.data.find((number) => number.agent_id === agentId);
  if (linked) {
    const record: PhoneNumberRecord = {
      id: linked.id,
      e164: linked.e164,
      agentId: linked.agent_id ?? agentId,
      label: linked.label ?? null,
      updatedAt: new Date().toISOString(),
    };
    db.upsertPhoneNumber(record);
    return { phoneNumber: record, requestPending: false, note: null };
  }

  const unassigned = numbers.data.find((number) => number.agent_id === null);
  if (unassigned) {
    const updated = await bimpe.phoneNumbers.update(unassigned.id, {
      agent_id: agentId,
      label: `${env.INTERVIEWER_AGENT_NAME} line`,
    });
    const record: PhoneNumberRecord = {
      id: updated.id,
      e164: updated.e164,
      agentId: updated.agent_id ?? agentId,
      label: updated.label ?? null,
      updatedAt: new Date().toISOString(),
    };
    db.upsertPhoneNumber(record);
    logger.info('Linked existing phone number to interviewer', { e164: updated.e164 });
    return { phoneNumber: record, requestPending: false, note: null };
  }

  // No number available: check for an in-flight request before creating another.
  const requests = await bimpe.phoneNumbers.requests.list({ limit: 100 });
  const pending = requests.data.some((request) => {
    const status = String(request.status ?? '').toLowerCase();
    return !request.e164 && !['fulfilled', 'rejected', 'cancelled', 'failed'].includes(status);
  });

  if (!pending) {
    await bimpe.phoneNumbers.requests.create({
      business_name: env.PHONE_BUSINESS_NAME,
      intended_use: env.PHONE_INTENDED_USE,
      region: env.PHONE_REGION,
      agent_count: 1,
      outbound_minutes: env.PHONE_OUTBOUND_MINUTES,
      submitted_by_agent_id: agentId,
    });
    logger.info('Filed phone number provisioning request', { region: env.PHONE_REGION });
  }

  return {
    phoneNumber: null,
    requestPending: true,
    note: 'No telephony number is linked yet. A provisioning request is pending with BimpeAI; calls need a linked number.',
  };
}

/** Ensure all agents exist and a number is linked. Idempotent. */
export async function ensureProvisioned(): Promise<ProvisioningSummary> {
  const notes: string[] = [];
  let interviewer: ProvisionedAgent | null = null;
  let evaluator: ProvisionedAgent | null = null;
  let assistant: ProvisionedAgent | null = null;

  try {
    interviewer = await ensureInterviewer();
  } catch (error) {
    notes.push(`Interviewer provisioning failed: ${describeError(error)}`);
  }

  try {
    evaluator = await ensureEvaluator();
  } catch (error) {
    notes.push(`Evaluator provisioning failed: ${describeError(error)}`);
  }

  try {
    assistant = await ensureAssistant();
  } catch (error) {
    notes.push(`Hiring assistant provisioning failed: ${describeError(error)}`);
  }

  // Promote every agent to `live` so the platform will actually route messages.
  for (const agent of [interviewer, evaluator, assistant]) {
    if (!agent) continue;
    try {
      const detail = await bimpe.agents.retrieve(agent.agentId);
      if (detail.status !== 'live') {
        await bimpe.agents.updateLiveStatus(agent.agentId, {
          status: 'live',
          status_reason: 'AgentScrut provisioning',
        });
        logger.info('Promoted agent to live', { agentId: agent.agentId, role: agent.role });
      }
    } catch (error) {
      notes.push(`Could not set ${agent.role} agent to live: ${describeError(error)}`);
    }
  }

  let phone: PhoneProvisionResult = { phoneNumber: null, requestPending: false, note: null };
  if (interviewer) {
    try {
      phone = await ensurePhoneNumber(interviewer.agentId);
    } catch (error) {
      notes.push(`Phone number provisioning failed: ${describeError(error)}`);
    }
  }
  if (phone.note) notes.push(phone.note);

  // Surface channel readiness so the UI can warn before a call is attempted.
  if (interviewer) {
    try {
      const channels = await bimpe.agents.channels.list(interviewer.agentId);
      const voice = channels.find((channel) => channel.type === 'voice');
      const telephony = channels.find((channel) => channel.type === 'telephony');
      if (channels.length === 0) {
        notes.push('The interviewer agent has no channels connected. Connect telephony and voice in the BimpeAI dashboard.');
      }
      if (!telephony) {
        notes.push('No telephony channel is connected on the interviewer agent; outbound calls cannot be placed.');
      }
      if (voice && voice.status !== 'enabled') {
        notes.push(
          `The interviewer's voice channel is "${voice.status}". Enable it in the BimpeAI dashboard, or outbound calls will stay queued.`,
        );
      }
    } catch (error) {
      notes.push(`Could not read interviewer channels: ${describeError(error)}`);
    }
  }

  // The Hiring Assistant sends post-interview summaries and answers the owner,
  // so it needs a connected WhatsApp channel.
  if (assistant) {
    try {
      const channels = await bimpe.agents.channels.list(assistant.agentId);
      const whatsapp = channels.find((channel) => channel.type === 'whatsapp');
      if (!whatsapp) {
        notes.push(
          'The Hiring Assistant has no WhatsApp channel connected. Connect WhatsApp in the BimpeAI dashboard so it can message the owner.',
        );
      } else if (whatsapp.status !== 'enabled' && whatsapp.status !== 'connected') {
        notes.push(`The Hiring Assistant's WhatsApp channel is "${whatsapp.status}".`);
      }
    } catch (error) {
      notes.push(`Could not read hiring assistant channels: ${describeError(error)}`);
    }
  }
  if (!env.OWNER_WHATSAPP) {
    notes.push('OWNER_WHATSAPP is not set; post-interview summaries cannot be delivered.');
  }

  const agents: Record<AgentRole, ProvisionedAgent | null> = { interviewer, evaluator, assistant };
  return {
    ready: Boolean(interviewer && evaluator),
    agents,
    phoneNumber: phone.phoneNumber,
    phoneRequestPending: phone.requestPending,
    notes,
  };
}
