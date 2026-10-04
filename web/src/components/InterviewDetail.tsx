import { useState } from 'react';
import type { InterviewEvent, InterviewRecord } from '../types';
import { ScorecardView } from './Scorecard';
import { Transcript } from './Transcript';
import { Badge, Button, Card, Spinner, Stat } from './ui';

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function InterviewDetail({
  interview,
  events,
  busy,
  onStart,
  onRedial,
  onSimulate,
  onReevaluate,
  onSendSummary,
  onImportTranscript,
  onCancel,
}: {
  interview: InterviewRecord;
  events: InterviewEvent[];
  busy: boolean;
  onStart: () => void;
  onRedial: () => void;
  onSimulate: () => void;
  onReevaluate: () => void;
  onSendSummary: () => void;
  onImportTranscript: (transcript: string) => void;
  onCancel: () => void;
}) {
  const [transcriptText, setTranscriptText] = useState('');
  const active = interview.status === 'calling' || interview.status === 'in_progress';
  const finished = interview.status === 'completed' || interview.status === 'failed';
  const needsTranscript = interview.transcript.length === 0 && !active;

  return (
    <div className="space-y-5">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-xl font-semibold text-slate-50">{interview.candidateName}</h2>
              <Badge value={interview.status} />
            </div>
            <p className="mt-1 text-sm text-slate-400">
              {interview.jobTitle}
              {interview.seniority ? ` · ${interview.seniority}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {busy && <Spinner />}
            {!active && !finished && (
              <>
                <Button onClick={onStart} disabled={busy}>Start call</Button>
                <Button variant="secondary" onClick={onSimulate} disabled={busy}>Simulate</Button>
              </>
            )}
            {active && (
              <Button variant="secondary" onClick={onCancel} disabled={busy}>
                Cancel call
              </Button>
            )}
            {finished && (
              <>
                <Button onClick={onRedial} disabled={busy}>Call again</Button>
                {interview.transcript.length > 0 && (
                  <Button variant="secondary" onClick={onReevaluate} disabled={busy}>Re-evaluate</Button>
                )}
                <Button variant="secondary" onClick={onSendSummary} disabled={busy}>Send summary</Button>
              </>
            )}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Candidate phone" value={interview.candidatePhone} />
          <Stat
            label="Decision"
            value={interview.scorecard ? `${interview.scorecard.overallScore}/100 · ${interview.scorecard.decision}` : '—'}
          />
          <Stat label="Call length" value={interview.durationSeconds != null ? `${interview.durationSeconds}s` : '—'} />
          <Stat label="Threshold" value={String(interview.passThreshold)} />
        </div>

        {interview.error && (
          <p className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">{interview.error}</p>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Live transcript</h3>
          <Transcript turns={interview.transcript} status={interview.status} />
          {needsTranscript && (
            <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
              <p className="text-xs text-slate-500">
                No transcript came back from BimpeAI for this call. Paste the conversation below — one turn per
                line, for example <span className="font-mono">Interviewer: …</span> or{' '}
                <span className="font-mono">Candidate: …</span> — to score it and send the owner a summary.
              </p>
              <textarea
                value={transcriptText}
                onChange={(event) => setTranscriptText(event.target.value)}
                rows={6}
                placeholder={'Interviewer: Thanks for taking my call. Is now still a good time?\nCandidate: Yes, go ahead.'}
                className="w-full rounded-lg border border-slate-800 bg-slate-950/60 p-2 font-mono text-xs text-slate-200 outline-none focus:border-brand-500"
              />
              <Button
                variant="secondary"
                disabled={busy || transcriptText.trim().length === 0}
                onClick={() => onImportTranscript(transcriptText)}
              >
                Import &amp; score
              </Button>
            </div>
          )}
        </Card>

        <div className="space-y-5">
          {interview.scorecard ? (
            <ScorecardView scorecard={interview.scorecard} threshold={interview.passThreshold} />
          ) : (
            <Card>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Scorecard</h3>
              <p className="mt-2 text-sm text-slate-500">
                {finished ? 'No scorecard was produced.' : 'The scorecard appears after the call ends.'}
              </p>
            </Card>
          )}

          <Card className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Summary to owner</h3>
              <Badge
                value={interview.summary ? 'sent' : 'pending'}
                label={interview.summary ? 'Sent' : 'Pending'}
              />
            </div>
            <p className="text-xs text-slate-500">
              The Hiring Assistant sends a short summary of this candidate to the owner on WhatsApp
              (test channel — it delivers once the owner has texted the assistant), and answers
              follow-up questions about every candidate.
            </p>
            {interview.summary ? (
              <pre className="max-h-60 overflow-y-auto whitespace-pre-wrap rounded-lg bg-slate-950/60 p-3 text-xs text-slate-300">
                {interview.summary}
              </pre>
            ) : (
              <p className="text-xs text-slate-600">No summary yet.</p>
            )}
          </Card>

          <Card>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">Activity</h3>
            <ol className="space-y-2">
              {events.slice(-14).map((event) => (
                <li key={event.id} className="flex gap-3 text-xs">
                  <span className="w-20 shrink-0 font-mono text-slate-600">{formatTime(event.createdAt)}</span>
                  <span className="text-slate-300">{event.message}</span>
                </li>
              ))}
              {events.length === 0 && <li className="text-xs text-slate-600">No activity yet.</li>}
            </ol>
          </Card>
        </div>
      </div>
    </div>
  );
}
