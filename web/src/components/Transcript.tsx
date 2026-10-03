import { useEffect, useRef } from 'react';
import type { InterviewStatus, TranscriptTurn } from '../types';

function bubbleClass(role: string): string {
  if (role === 'assistant') return 'bg-slate-800 text-slate-100';
  if (role === 'user' || role === 'customer' || role === 'restaurant_user') return 'bg-brand-600 text-white';
  return 'bg-slate-700 text-slate-200';
}

function roleLabel(role: string): string {
  if (role === 'assistant') return 'Interviewer';
  if (role === 'user') return 'Candidate';
  return role;
}

function emptyMessage(status?: InterviewStatus): string {
  if (status === 'calling' || status === 'in_progress') {
    return 'Waiting for the transcript. Turns appear here as the call progresses.';
  }
  if (status === 'completed' || status === 'failed') {
    return 'BimpeAI returned no transcript for this call. You can paste one below to score it.';
  }
  return 'No transcript yet. The conversation appears here live.';
}

export function Transcript({ turns, status }: { turns: TranscriptTurn[]; status?: InterviewStatus }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns.length]);

  return (
    <div className="max-h-[420px] space-y-3 overflow-y-auto rounded-xl border border-slate-800 bg-slate-950/40 p-4">
      {turns.length === 0 && (
        <p className="py-8 text-center text-sm text-slate-600">{emptyMessage(status)}</p>
      )}
      {turns.map((turn) => (
        <div key={turn.id} className={`flex flex-col ${turn.role === 'assistant' ? 'items-start' : 'items-end'}`}>
          <span className="mb-1 text-[10px] uppercase tracking-wide text-slate-600">{roleLabel(turn.role)}</span>
          <div className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${bubbleClass(turn.role)}`}>
            {turn.message}
          </div>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
