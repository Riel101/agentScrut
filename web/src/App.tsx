import { useCallback, useEffect, useRef, useState } from 'react';
import { api, subscribeToInterview } from './api';
import { InterviewDetail } from './components/InterviewDetail';
import { NewInterviewForm } from './components/NewInterviewForm';
import { SystemStatusPanel } from './components/SystemStatus';
import { Badge, Button, Card, Spinner } from './components/ui';
import type { InterviewEvent, InterviewRecord, SystemStatus, TranscriptTurn } from './types';

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Append a live transcript turn locally, skipping duplicates by id. */
function upsertTurn(turns: TranscriptTurn[], turn: TranscriptTurn): TranscriptTurn[] {
  if (turns.some((item) => item.id === turn.id)) return turns;
  return [...turns, turn];
}

export default function App() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [interviews, setInterviews] = useState<InterviewRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<InterviewRecord | null>(null);
  const [events, setEvents] = useState<Record<string, InterviewEvent[]>>({});
  const [view, setView] = useState<'new' | 'detail'>('new');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupNotes, setSetupNotes] = useState<string[]>([]);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.status());
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : 'Could not load status');
    }
  }, []);

  const loadInterviews = useCallback(async () => {
    const result = await api.listInterviews();
    setInterviews(result.data);
  }, []);

  const refreshInterview = useCallback(async (id: string) => {
    const result = await api.getInterview(id);
    setSelected((current) => (current?.id === id ? result.data : current));
    setInterviews((current) => current.map((item) => (item.id === id ? result.data : item)));
  }, []);

  useEffect(() => {
    void loadStatus();
    void loadInterviews();
  }, [loadStatus, loadInterviews]);

  // Subscribe to live events for the selected interview.
  useEffect(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    if (!selectedId) return;

    const unsubscribe = subscribeToInterview(selectedId, (event) => {
      setEvents((current) => {
        const list = current[selectedId] ?? [];
        if (list.some((item) => item.id === event.id)) return current;
        return { ...current, [selectedId]: [...list, event] };
      });

      // Render transcript turns straight from the stream so the conversation
      // appears live, without waiting for a full record refresh.
      if (event.type === 'transcript') {
        const turn: TranscriptTurn = {
          id: String(event.data?.turnId ?? event.id),
          role: String(event.data?.role ?? 'user'),
          message: event.message,
          createdAt: String(event.data?.createdAt ?? event.createdAt),
        };
        setSelected((current) =>
          current && current.id === selectedId
            ? { ...current, transcript: upsertTurn(current.transcript, turn) }
            : current,
        );
        setInterviews((current) =>
          current.map((item) =>
            item.id === selectedId ? { ...item, transcript: upsertTurn(item.transcript, turn) } : item,
          ),
        );
      } else {
        void refreshInterview(selectedId);
      }
    });
    unsubscribeRef.current = unsubscribe;
    return () => unsubscribe();
  }, [selectedId, refreshInterview]);

  const selectInterview = useCallback(
    async (id: string) => {
      setSelectedId(id);
      setView('detail');
      const result = await api.getInterview(id);
      setSelected(result.data);
    },
    [],
  );

  const run = useCallback(
    async (action: () => Promise<unknown>, interviewId?: string) => {
      setBusy(true);
      setError(null);
      try {
        await action();
        await loadInterviews();
        await loadStatus();
        if (interviewId) await refreshInterview(interviewId);
      } catch (actionError) {
        setError(actionError instanceof Error ? actionError.message : 'Action failed');
      } finally {
        setBusy(false);
      }
    },
    [loadInterviews, loadStatus, refreshInterview],
  );

  return (
    <div className="flex h-full">
      <aside className="flex w-80 shrink-0 flex-col border-r border-slate-800 bg-slate-900/40">
        <div className="border-b border-slate-800 p-4">
          <h1 className="text-lg font-semibold text-slate-50">AgentScrut</h1>
          <p className="text-xs text-slate-500">AI voice interviewer · BimpeAI SDK</p>
          <Button className="mt-3 w-full" onClick={() => { setView('new'); setSelectedId(null); }}>
            + New interview
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {interviews.length === 0 && <p className="p-4 text-sm text-slate-600">No interviews yet.</p>}
          {interviews.map((interview) => (
            <button
              key={interview.id}
              onClick={() => void selectInterview(interview.id)}
              className={`mb-1 w-full rounded-lg px-3 py-2.5 text-left transition ${
                selectedId === interview.id ? 'bg-slate-800' : 'hover:bg-slate-800/50'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium text-slate-200">{interview.candidateName}</span>
                <Badge value={interview.status} />
              </div>
              <div className="mt-0.5 truncate text-xs text-slate-500">{interview.jobTitle}</div>
              <div className="mt-0.5 text-[10px] text-slate-600">{timeAgo(interview.createdAt)}</div>
            </button>
          ))}
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-6xl space-y-5">
          {error && (
            <div className="flex items-center justify-between rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
              <span>{error}</span>
              <button onClick={() => setError(null)} className="text-rose-300 hover:text-rose-100">dismiss</button>
            </div>
          )}

          <SystemStatusPanel
            status={status}
            notes={setupNotes}
            busy={busy}
            onSetup={() =>
              void run(async () => {
                const summary = await api.setup();
                setSetupNotes(summary.notes);
              })
            }
          />

          {view === 'detail' && selected ? (
            <InterviewDetail
              interview={selected}
              events={events[selected.id] ?? []}
              busy={busy}
              onStart={() => void run(() => api.startInterview(selected.id), selected.id)}
              onSimulate={() => void run(() => api.simulateInterview(selected.id), selected.id)}
              onReevaluate={() => void run(() => api.reevaluate(selected.id), selected.id)}
              onSendSummary={() => void run(() => api.sendSummary(selected.id), selected.id)}
              onImportTranscript={(text) =>
                void run(() => api.importTranscript(selected.id, text), selected.id)
              }
              onCancel={() => void run(() => api.cancelInterview(selected.id), selected.id)}
            />
          ) : (
            <NewInterviewForm
              defaultThreshold={status?.config.passThreshold ?? 70}
              onCreated={(record, startNow) => {
                setInterviews((current) => [record, ...current]);
                setSelected(record);
                setSelectedId(record.id);
                setView('detail');
                if (startNow) void run(() => api.startInterview(record.id), record.id);
              }}
            />
          )}

          {view === 'detail' && !selected && busy && (
            <Card className="flex items-center gap-3 text-sm text-slate-400">
              <Spinner /> Loading interview…
            </Card>
          )}
        </div>
      </main>
    </div>
  );
}
