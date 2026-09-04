/**
 * Claude-backed SummaryProvider for the forecast board.
 *
 * The design contract from packages/core/src/forecast.ts is the whole point,
 * and it is NOT stylistic:
 *   1. The model receives the FINISHED numbers and may not recompute them.
 *      Every figure in the prose must trace to an AlertDraft the engine produced.
 *   2. The output is presentation only. Nothing downstream reads it as data, no
 *      decision branches on it, and it never reaches payroll.
 *
 * So the model's only job is ranking + phrasing: given the computed alerts, say
 * which two or three matter most this morning, in a couple of sentences. On any
 * error — or when no credentials are configured — we fall back to the
 * deterministic `templateSummary`, so the board always renders.
 */
import { templateSummary, type ForecastBundle, type SummaryProvider } from '@timeclock/core';

const SYSTEM = [
  'You are a shift-operations assistant writing the one-line morning read for a',
  'supervisor dashboard in a wage-and-hour time-clock system.',
  '',
  'You are given a list of ALREADY-COMPUTED alerts (coverage gaps, overtime',
  'forecasts, meal-deadline risks, and adherence findings). Your ONLY job is to',
  'rank and phrase them.',
  '',
  'Hard rules:',
  '- Use ONLY the numbers present in the alerts. Never invent, round, or',
  '  recompute any figure — these are legal wage-and-hour numbers.',
  '- Name the 2–3 most pressing items (critical before warning). Prefer meal',
  '  and coverage risks that are still actionable today.',
  '- 2–3 sentences, plain text, no markdown, no preamble, no bullet list.',
  '- If there are no alerts, say the day looks clear in one short sentence.',
].join('\n');

export interface ClaudeSummaryOptions {
  apiKey?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  timeoutMs?: number;
}

export class ClaudeSummaryProvider implements SummaryProvider {
  readonly kind = 'claude';
  /** What actually produced the most recent summary — 'claude' or, on fallback, 'template'. */
  lastOutcome: 'claude' | 'template' = 'template';
  private clientPromise: Promise<{ messages: { create: (b: unknown) => Promise<unknown> } }> | null = null;

  constructor(private readonly opts: ClaudeSummaryOptions = {}) {}

  private async client() {
    if (!this.clientPromise) {
      // Lazy import so a credential-free run never loads the SDK at all.
      this.clientPromise = import('@anthropic-ai/sdk').then((m) => {
        const Anthropic = m.default;
        return new Anthropic(this.opts.apiKey ? { apiKey: this.opts.apiKey } : {}) as never;
      });
    }
    return this.clientPromise;
  }

  async summarize(bundle: ForecastBundle): Promise<string> {
    try {
      const client = await this.client();
      const req = {
        model: this.opts.model ?? 'claude-opus-5',
        max_tokens: 512,
        output_config: { effort: this.opts.effort ?? 'low' },
        system: SYSTEM,
        messages: [{ role: 'user', content: JSON.stringify(bundleForPrompt(bundle)) }],
      };
      const resp = (await (client.messages.create as (b: unknown, o?: unknown) => Promise<unknown>)(
        req,
        { timeout: this.opts.timeoutMs ?? 20_000 },
      )) as { content?: { type: string; text?: string }[] };
      const text = (resp.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
        .trim();
      if (text) {
        this.lastOutcome = 'claude';
        return text;
      }
      this.lastOutcome = 'template';
      return templateSummary.summarize(bundle);
    } catch (err) {
      console.error('[summary] Claude provider failed, using template:', (err as Error)?.message);
      this.lastOutcome = 'template';
      return templateSummary.summarize(bundle);
    }
  }
}

/** Hand the model only what it needs to rank + phrase — the finished figures. */
function bundleForPrompt(b: ForecastBundle) {
  return {
    workDate: b.workDate,
    headcount: b.headcount,
    alerts: b.alerts.map((a) => ({
      severity: a.severity,
      kind: a.kind,
      message: a.message,
      detail: a.detail ?? null,
    })),
  };
}

/**
 * Pick the provider from the environment. With a key configured, summaries are
 * Claude-generated; otherwise the deterministic template runs — so the demo and
 * tests need no credentials.
 */
export function makeSummaryProvider(): SummaryProvider {
  const hasCreds = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  if (!hasCreds) return templateSummary;
  return new ClaudeSummaryProvider({
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
    effort: 'low',
  });
}

/** Label for the UI: which provider actually produced a summary. */
export function providerKind(p: SummaryProvider): 'claude' | 'template' {
  return p instanceof ClaudeSummaryProvider ? 'claude' : 'template';
}
