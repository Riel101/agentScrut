import type {
  CreateInterviewInput,
  InterviewEvent,
  InterviewRecord,
  ProvisioningSummary,
  SystemStatus,
} from './types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : {};
  if (!response.ok) {
    const message =
      (payload as { error?: string }).error ?? `Request failed with ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

export const api = {
  status: () => request<SystemStatus>('/api/status'),
  setup: () => request<ProvisioningSummary>('/api/setup', { method: 'POST', body: '{}' }),
  listInterviews: () => request<{ data: InterviewRecord[] }>('/api/interviews'),
  getInterview: (id: string) => request<{ data: InterviewRecord }>(`/api/interviews/${id}`),
  createInterview: (input: CreateInterviewInput) =>
    request<{ data: InterviewRecord }>('/api/interviews', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  startInterview: (id: string) =>
    request<{ data: InterviewRecord }>(`/api/interviews/${id}/start`, { method: 'POST', body: '{}' }),
  simulateInterview: (id: string) =>
    request<{ data: InterviewRecord }>(`/api/interviews/${id}/simulate`, {
      method: 'POST',
      body: '{}',
    }),
  reevaluate: (id: string) =>
    request<{ data: InterviewRecord }>(`/api/interviews/${id}/evaluate`, {
      method: 'POST',
      body: '{}',
    }),
  sendSummary: (id: string) =>
    request<{ data: InterviewRecord }>(`/api/interviews/${id}/summary`, {
      method: 'POST',
      body: '{}',
    }),
  importTranscript: (id: string, transcript: string) =>
    request<{ data: InterviewRecord }>(`/api/interviews/${id}/transcript`, {
      method: 'POST',
      body: JSON.stringify({ transcript }),
    }),
  cancelInterview: (id: string) =>
    request<{ data: InterviewRecord }>(`/api/interviews/${id}/cancel`, {
      method: 'POST',
      body: '{}',
    }),
};

export function subscribeToInterview(
  id: string,
  onEvent: (event: InterviewEvent) => void,
): () => void {
  const source = new EventSource(`/api/interviews/${id}/events`);
  const listener = (raw: MessageEvent) => {
    try {
      onEvent(JSON.parse(raw.data) as InterviewEvent);
    } catch {
      /* ignore malformed frame */
    }
  };
  const types = [
    'created',
    'notice',
    'provisioning',
    'calling',
    'call_started',
    'in_progress',
    'transcript',
    'call_ended',
    'cap_reached',
    'ring_timeout',
    'scorecard',
    'scorecard_skipped',
    'transcript_missing',
    'summary_sending',
    'summary_sent',
    'summary_failed',
    'completed',
    'error',
  ];
  for (const type of types) source.addEventListener(type, listener as EventListener);
  return () => source.close();
}
