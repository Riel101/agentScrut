/**
 * Probe one call's full detail plus the interviewer agent's live status.
 * Usage:  npx tsx src/scripts/probe-call.ts <callId>
 */
import { bimpe, describeError } from '../bimpe.js';
import { env } from '../env.js';

async function main(): Promise<void> {
  const callId = process.argv[2];

  const agents = await bimpe.agents.list({ limit: 100 });
  const interviewer = agents.data.find(
    (agent) => agent.name.toLowerCase() === env.INTERVIEWER_AGENT_NAME.toLowerCase(),
  );
  if (!interviewer) {
    console.log('Interviewer agent not found.');
    return;
  }

  const detail = await bimpe.agents.retrieve(interviewer.id);
  console.log('Interviewer agent:');
  console.log(
    JSON.stringify(
      {
        id: detail.id,
        status: detail.status,
        status_reason: detail.status_reason,
        channels: detail.channels,
      },
      null,
      2,
    ),
  );

  const resolvedCallId =
    callId ??
    (await bimpe.calls.list(interviewer.id, { limit: 1, sort: '-created_on' })).data[0]?.id;
  if (!resolvedCallId) {
    console.log('\nNo calls found.');
    return;
  }

  const call = await bimpe.calls.retrieve(interviewer.id, resolvedCallId);
  console.log('\nCall detail:');
  console.log(
    JSON.stringify(
      {
        id: call.id,
        destination: call.destination,
        source: call.source,
        status: call.status,
        duration_seconds: call.duration_seconds,
        error_reason: call.error_reason,
        end_reason: call.end_reason,
        ringing_at: call.ringing_at,
        answered_at: call.answered_at,
        ended_at: call.ended_at,
        created_on: call.created_on,
        transcript_turns: call.conversation_logs.length,
      },
      null,
      2,
    ),
  );
  if (call.conversation_logs.length > 0) {
    console.log('\nTranscript:');
    for (const entry of call.conversation_logs) {
      console.log(`  ${entry.role}: ${entry.message ?? '(no text)'}`);
    }
  }
}

main().catch((error) => {
  console.error('Probe failed:', describeError(error));
  process.exit(1);
});
