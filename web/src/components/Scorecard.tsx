import type { Scorecard } from '../types';
import { Badge, Card, ProgressBar } from './ui';

export function ScorecardView({ scorecard, threshold }: { scorecard: Scorecard; threshold: number }) {
  return (
    <Card className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Scorecard</h3>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-3xl font-semibold text-slate-50">{scorecard.overallScore}</span>
            <span className="text-sm text-slate-500">/ 100 · threshold {threshold}</span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <Badge value={scorecard.decision} />
          <Badge
            value={scorecard.source === 'evaluator-agent' ? 'sent' : 'pending'}
            label={scorecard.source === 'evaluator-agent' ? 'Evaluator agent' : 'Heuristic fallback'}
          />
        </div>
      </div>

      <ProgressBar value={scorecard.overallScore} />

      <p className="text-sm leading-relaxed text-slate-300">{scorecard.summary}</p>

      <div className="space-y-3">
        {scorecard.dimensions.map((dimension) => (
          <div key={dimension.name}>
            <div className="mb-1 flex items-center justify-between text-xs text-slate-400">
              <span className="font-medium text-slate-300">{dimension.name}</span>
              <span>{dimension.score}/100</span>
            </div>
            <ProgressBar value={dimension.score} />
            <p className="mt-1 text-xs text-slate-500">{dimension.rationale}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-emerald-400">Strengths</div>
          <ul className="list-inside list-disc space-y-1 text-sm text-slate-300">
            {scorecard.strengths.length ? scorecard.strengths.map((item) => <li key={item}>{item}</li>) : <li className="text-slate-500">None noted</li>}
          </ul>
        </div>
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-rose-400">Concerns</div>
          <ul className="list-inside list-disc space-y-1 text-sm text-slate-300">
            {scorecard.concerns.length ? scorecard.concerns.map((item) => <li key={item}>{item}</li>) : <li className="text-slate-500">None noted</li>}
          </ul>
        </div>
      </div>

      <p className="rounded-lg bg-slate-800/40 p-3 text-sm text-slate-300">
        <span className="font-medium text-slate-200">Next step: </span>
        {scorecard.recommendedNextStep}
      </p>
    </Card>
  );
}
