import type { SystemStatus } from '../types';
import { Badge, Button, Card, Spinner } from './ui';

export function SystemStatusPanel({
  status,
  notes,
  onSetup,
  busy,
}: {
  status: SystemStatus | null;
  notes: string[];
  onSetup: () => void;
  busy: boolean;
}) {
  const interviewer = status?.agents.interviewer;
  const evaluator = status?.agents.evaluator;
  const assistant = status?.agents.assistant;
  const number = status?.phoneNumbers[0];
  const ready = Boolean(interviewer && evaluator);
  const allNotes = Array.from(new Set([...(status?.warnings ?? []), ...notes]));

  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Platform status</h2>
        <div className="flex items-center gap-2">
          {busy && <Spinner />}
          <Button variant="secondary" onClick={onSetup} disabled={busy}>
            {ready ? 'Re-run setup' : 'Provision agents'}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm lg:grid-cols-3">
        <div className="rounded-lg bg-slate-800/40 px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-slate-500">Interviewer</div>
          <div className="mt-0.5 truncate text-slate-200">{interviewer?.name ?? '—'}</div>
          {interviewer && <div className="truncate text-[11px] text-slate-500">{interviewer.agentId}</div>}
        </div>
        <div className="rounded-lg bg-slate-800/40 px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-slate-500">Evaluator</div>
          <div className="mt-0.5 truncate text-slate-200">{evaluator?.name ?? '—'}</div>
          {evaluator && <div className="truncate text-[11px] text-slate-500">{evaluator.agentId}</div>}
        </div>
        <div className="rounded-lg bg-slate-800/40 px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-slate-500">Hiring Assistant</div>
          <div className="mt-0.5 truncate text-slate-200">{assistant?.name ?? '—'}</div>
          {assistant && <div className="truncate text-[11px] text-slate-500">{assistant.agentId}</div>}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge value={ready ? 'ready' : 'pending'} label={ready ? 'Agents ready' : 'Agents missing'} />
        {number ? (
          <Badge value="sent" label={`Voice line ${number.e164}`} />
        ) : (
          <Badge value="pending" label="No voice line yet" />
        )}
        {status && <Badge value="created" label={`Voice: ${status.voiceProvider}`} />}
        {status && <Badge value="created" label={`Cap ${Math.round(status.config.maxSeconds / 60)} min`} />}
      </div>

      {!number && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
          A telephony number is still being provisioned by BimpeAI. Until it is linked, live calls cannot be
          placed — use <span className="font-semibold">Simulate</span> to exercise the scoring and summary
          pipeline.
        </p>
      )}

      {allNotes.length > 0 && (
        <ul className="space-y-1.5">
          {allNotes.map((note) => (
            <li
              key={note}
              className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200"
            >
              {note}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
