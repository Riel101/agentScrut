import { useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../api';
import type { CreateInterviewInput, InterviewRecord } from '../types';
import { Button, Card } from './ui';

const initial = {
  jobTitle: '',
  seniority: '',
  jobDescription: '',
  keyRequirements: '',
  candidateName: '',
  candidatePhone: '',
  passThreshold: 70,
};

export function NewInterviewForm({
  onCreated,
  defaultThreshold,
}: {
  onCreated: (record: InterviewRecord, startNow: boolean) => void;
  defaultThreshold: number;
}) {
  const [form, setForm] = useState({ ...initial, passThreshold: defaultThreshold });
  const [startNow, setStartNow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const update = (key: keyof typeof form, value: string | number) =>
    setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const input: CreateInterviewInput = {
        jobTitle: form.jobTitle,
        jobDescription: form.jobDescription,
        seniority: form.seniority || undefined,
        keyRequirements: form.keyRequirements
          .split(/[\n,]/)
          .map((item) => item.trim())
          .filter(Boolean),
        candidateName: form.candidateName,
        candidatePhone: form.candidatePhone,
        passThreshold: form.passThreshold,
      };
      const result = await api.createInterview(input);
      setForm({ ...initial, passThreshold: defaultThreshold });
      onCreated(result.data, startNow);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const field = 'w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 placeholder-slate-600 focus:border-brand-500 focus:outline-none';
  const label = 'mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500';

  return (
    <Card>
      <h2 className="mb-4 text-lg font-semibold text-slate-100">New interview</h2>
      <form className="space-y-4" onSubmit={submit}>
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2 sm:col-span-1">
            <label className={label}>Job title</label>
            <input className={field} value={form.jobTitle} onChange={(e) => update('jobTitle', e.target.value)} required placeholder="Senior Backend Engineer" />
          </div>
          <div className="col-span-2 sm:col-span-1">
            <label className={label}>Seniority (optional)</label>
            <input className={field} value={form.seniority} onChange={(e) => update('seniority', e.target.value)} placeholder="senior" />
          </div>
        </div>

        <div>
          <label className={label}>Job description</label>
          <textarea
            className={`${field} min-h-[120px] resize-y`}
            value={form.jobDescription}
            onChange={(e) => update('jobDescription', e.target.value)}
            required
            placeholder="Paste the role description. The interviewer is specialised to this before the call."
          />
        </div>

        <div>
          <label className={label}>Key requirements (comma or newline separated)</label>
          <textarea
            className={`${field} min-h-[70px] resize-y`}
            value={form.keyRequirements}
            onChange={(e) => update('keyRequirements', e.target.value)}
            placeholder="Node.js, PostgreSQL, distributed systems"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2 sm:col-span-1">
            <label className={label}>Candidate name</label>
            <input className={field} value={form.candidateName} onChange={(e) => update('candidateName', e.target.value)} required placeholder="Ada Lovelace" />
          </div>
          <div className="col-span-2 sm:col-span-1">
            <label className={label}>Candidate phone (E.164)</label>
            <input className={field} value={form.candidatePhone} onChange={(e) => update('candidatePhone', e.target.value)} required placeholder="+2348012345678" />
          </div>
          <div className="col-span-2 sm:col-span-1">
            <label className={label}>Pass threshold (0-100)</label>
            <input
              className={field}
              type="number"
              min={0}
              max={100}
              value={form.passThreshold}
              onChange={(e) => update('passThreshold', Number(e.target.value))}
            />
          </div>
        </div>

        <p className="text-xs text-slate-500">
          After the interview, the Hiring Assistant sends a short performance summary to the owner on WhatsApp.
        </p>

        {error && <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</p>}

        <div className="flex items-center justify-between pt-1">
          <label className="flex items-center gap-2 text-sm text-slate-400">
            <input type="checkbox" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} className="h-4 w-4 rounded border-slate-600 bg-slate-900" />
            Start the call immediately
          </label>
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Create interview'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
