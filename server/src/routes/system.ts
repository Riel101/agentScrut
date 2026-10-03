import { Router } from 'express';
import { bimpe } from '../bimpe.js';
import { db } from '../db.js';
import { env } from '../env.js';
import type { AgentRole } from '../types.js';
import { ensureProvisioned } from '../services/provisioning.js';

export const systemRouter = Router();

systemRouter.get('/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), voiceProvider: env.VOICE_PROVIDER });
});

/** Read-only provisioning snapshot. */
systemRouter.get('/status', async (_req, res) => {
  const interviewer = db.getAgent('interviewer');
  const assistant = db.getAgent('assistant');
  const warnings: string[] = [];
  let channels: Array<{ id: string; type: string; name: string; status: string; is_connected: boolean }> = [];
  let assistantChannels: Array<{ id: string; type: string; name: string; status: string; is_connected: boolean }> = [];

  if (interviewer) {
    try {
      channels = [...(await bimpe.agents.channels.list(interviewer.agentId))];
      const voice = channels.find((channel) => channel.type === 'voice');
      const telephony = channels.find((channel) => channel.type === 'telephony');
      if (channels.length === 0) {
        warnings.push('The interviewer agent has no channels connected.');
      }
      if (!telephony) {
        warnings.push('No telephony channel is connected; outbound calls cannot be placed.');
      }
      if (voice && voice.status !== 'enabled') {
        warnings.push(`The interviewer's voice channel is "${voice.status}"; enable it in the BimpeAI dashboard or calls stay queued.`);
      }
    } catch {
      warnings.push('Could not read the interviewer agent channels.');
    }
  }

  if (assistant) {
    try {
      assistantChannels = [...(await bimpe.agents.channels.list(assistant.agentId))];
      const whatsapp = assistantChannels.find((channel) => channel.type === 'whatsapp');
      if (!whatsapp) {
        warnings.push('The Hiring Assistant has no WhatsApp channel connected; interview summaries cannot be delivered.');
      } else if (whatsapp.status !== 'enabled' && whatsapp.status !== 'connected') {
        warnings.push(`The Hiring Assistant's WhatsApp channel is "${whatsapp.status}".`);
      }
    } catch {
      warnings.push('Could not read the Hiring Assistant channels.');
    }
  } else {
    warnings.push('The Hiring Assistant is not provisioned yet; run setup to create it.');
  }

  if (!env.OWNER_WHATSAPP) {
    warnings.push('OWNER_WHATSAPP is not set; post-interview summaries have nowhere to go.');
  }

  const numbers = db.listPhoneNumbers();
  if (interviewer && numbers.every((number) => number.agentId !== interviewer.agentId)) {
    warnings.push('No telephony number is linked to the interviewer agent yet.');
  }

  res.json({
    voiceProvider: env.VOICE_PROVIDER,
    config: {
      maxSeconds: env.INTERVIEW_MAX_SECONDS,
      passThreshold: env.INTERVIEW_PASS_THRESHOLD,
      agentNames: {
        interviewer: env.INTERVIEWER_AGENT_NAME,
        evaluator: env.EVALUATOR_AGENT_NAME,
        assistant: env.ASSISTANT_AGENT_NAME,
      },
      ownerWhatsapp: env.OWNER_WHATSAPP || null,
    },
    agents: {
      interviewer,
      evaluator: db.getAgent('evaluator'),
      assistant,
    },
    channels,
    assistantChannels,
    warnings,
    phoneNumbers: numbers,
  });
});

/** Create/repair the BimpeAI agents and phone number. Idempotent. */
systemRouter.post('/setup', async (_req, res) => {
  try {
    const summary = await ensureProvisioned();
    res.json(summary);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** List the channels (whatsapp, telephony, …) on a provisioned agent. */
systemRouter.get('/agents/:role/channels', async (req, res) => {
  const role = req.params.role as AgentRole;
  if (role !== 'interviewer' && role !== 'evaluator' && role !== 'assistant') {
    res.status(400).json({ error: 'role must be "interviewer", "evaluator", or "assistant"' });
    return;
  }
  const agent = db.getAgent(role);
  if (!agent) {
    res.status(404).json({ error: `No ${role} agent provisioned yet. Run setup first.` });
    return;
  }
  try {
    const channels = await bimpe.agents.channels.list(agent.agentId);
    res.json({ agentId: agent.agentId, channels });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
