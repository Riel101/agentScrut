import { env } from '../env.js';
import { db } from '../db.js';

const base = `${env.BIMPE_BASE_URL.replace(/\/$/, '')}/api/v1/console`;
const agent = db.getAgent('interviewer')!;
const callId = 'cmusdk76a00bims88xr6wl9t3';
const telConv = 'cmus1445302eqpy87nddnvba4';

async function raw(path: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}${path}`, {
    headers: {
      Authorization: `Bearer ${env.BIMPE_API_KEY}`,
      Accept: 'application/json',
      'X-Client': 'agentscrut-server',
    },
  });
  return { status: res.status, text: await res.text() };
}

const call = await raw(`/agents/${agent.agentId}/calls/${callId}`);
console.log('=== raw call detail ===');
console.log(call.text);

console.log('\n=== conversations is_test_channel=false ===');
const nonTest = await raw(`/agents/${agent.agentId}/conversations?limit=100&is_test_channel=false`);
console.log(nonTest.status, nonTest.text.slice(0, 800));

console.log('\n=== telephony conversation messages (raw) ===');
for (const path of [
  `/agents/${agent.agentId}/conversations/${telConv}/messages`,
  `/agents/${agent.agentId}/conversations/${telConv}/messages?limit=100`,
  `/agents/${agent.agentId}/conversations/${telConv}/messages?limit=100&sort=-created_at`,
]) {
  const r = await raw(path);
  console.log(`${path} -> ${r.status} ${r.text.slice(0, 300)}`);
}

console.log('\n=== stream ticket for telephony conversation ===');
const ticket = await raw(`/agents/${agent.agentId}/conversations/${telConv}/stream-ticket`);
console.log(ticket.status, ticket.text.slice(0, 300));

console.log('\n=== account-level conversation guesses ===');
for (const path of [
  `/conversations?limit=50`,
  `/conversations?agent_id=${agent.agentId}&limit=50`,
]) {
  const r = await raw(path);
  console.log(`${path} -> ${r.status} ${r.text.slice(0, 200)}`);
}
