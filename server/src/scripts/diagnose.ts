/**
 * Diagnostics: prints the live BimpeAI state for the AgentScrut agents.
 * Run with:  npx tsx src/scripts/diagnose.ts   (from the server workspace)
 */
import { bimpe, describeError } from '../bimpe.js';
import { env } from '../env.js';

async function main(): Promise<void> {
  console.log(`\n=== BimpeAI diagnostics ===`);
  console.log(`baseUrl: ${env.BIMPE_BASE_URL}`);
  console.log(`interviewer name: ${env.INTERVIEWER_AGENT_NAME}`);
  console.log(`evaluator name:   ${env.EVALUATOR_AGENT_NAME}\n`);

  // Agents
  const agents = await bimpe.agents.list({ limit: 100 });
  const interviewer = agents.data.find(
    (agent) => agent.name.toLowerCase() === env.INTERVIEWER_AGENT_NAME.toLowerCase(),
  );

  console.log(`Agents (${agents.data.length}):`);
  for (const agent of agents.data) {
    console.log(`  - ${agent.name}  id=${agent.id}  workflow=${agent.workflow_id}  status=${agent.status}`);
  }
  if (!interviewer) {
    console.log('\n!! Interviewer agent not found. Run POST /api/setup.');
    return;
  }

  // Channels
  try {
    const channels = await bimpe.agents.channels.list(interviewer.id);
    console.log(`\nInterviewer channels (${channels.length}):`);
    for (const channel of channels) {
      console.log(`  - ${channel.type}  status=${channel.status}  connected=${channel.is_connected}  name=${channel.name}`);
    }
    if (channels.length === 0) {
      console.log('  !! No channels. Telephony/WhatsApp are not connected for this agent.');
    }
  } catch (error) {
    console.log(`\nChannel lookup failed: ${describeError(error)}`);
  }

  // Phone numbers
  try {
    const numbers = await bimpe.phoneNumbers.list({ limit: 100 });
    console.log(`\nPhone numbers (${numbers.data.length}):`);
    for (const number of numbers.data) {
      console.log(`  - ${number.e164}  id=${number.id}  agent_id=${number.agent_id ?? '(unassigned)'}  label=${number.label ?? ''}`);
    }
    const linked = numbers.data.filter((number) => number.agent_id === interviewer.id);
    if (linked.length === 0) {
      console.log('  !! No phone number is linked to the interviewer agent. Outbound calls cannot be placed.');
    }
  } catch (error) {
    console.log(`\nPhone number lookup failed: ${describeError(error)}`);
  }

  // Provisioning requests
  try {
    const requests = await bimpe.phoneNumbers.requests.list({ limit: 100 });
    console.log(`\nPhone number requests (${requests.data.length}):`);
    for (const request of requests.data) {
      console.log(
        `  - id=${request.id}  status=${request.status ?? '?'}  region=${request.region ?? '?'}  e164=${request.e164 ?? '(pending)'}  agent_id=${request.agent_id ?? ''}`,
      );
    }
  } catch (error) {
    console.log(`\nRequest lookup failed: ${describeError(error)}`);
  }

  // Recent calls
  try {
    const calls = await bimpe.calls.list(interviewer.id, { limit: 10, sort: '-created_on' });
    console.log(`\nRecent calls (${calls.data.length}):`);
    for (const call of calls.data) {
      console.log(
        `  - ${call.id}  to=${call.destination}  status=${call.status}  test=${call.is_test_call}  error=${call.error_reason ?? ''}  created=${call.created_on}`,
      );
    }
    if (calls.data.length === 0) console.log('  (no calls have been placed)');
  } catch (error) {
    console.log(`\nCall lookup failed: ${describeError(error)}`);
  }

  console.log('');
}

main().catch((error) => {
  console.error('Diagnostics failed:', describeError(error));
  process.exit(1);
});
