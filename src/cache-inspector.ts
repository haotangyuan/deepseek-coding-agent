import type { SessionStats } from "@earendil-works/pi-coding-agent";

type TokenStats = SessionStats["tokens"];

export interface CacheUsage {
  hitTokens: number;
  missTokens: number;
  promptTokens: number;
  hitRate?: number;
}

export interface CacheReport {
  turn?: CacheUsage;
  session: CacheUsage;
  changePercentagePoints?: number;
  alert?: string;
}

const MIN_PROMPT_TOKENS_FOR_ALERT = 100;
const DROP_ALERT_PERCENTAGE_POINTS = 20;

function usage(tokens: Pick<TokenStats, "input" | "cacheRead" | "cacheWrite">): CacheUsage {
  const hitTokens = Math.max(0, tokens.cacheRead);
  const missTokens = Math.max(0, tokens.input + tokens.cacheWrite);
  const promptTokens = hitTokens + missTokens;
  return {
    hitTokens,
    missTokens,
    promptTokens,
    ...(promptTokens === 0 ? {} : { hitRate: hitTokens / promptTokens }),
  };
}

function delta(after: TokenStats, before: TokenStats): CacheUsage | undefined {
  const input = after.input - before.input;
  const cacheRead = after.cacheRead - before.cacheRead;
  const cacheWrite = after.cacheWrite - before.cacheWrite;
  if (input < 0 || cacheRead < 0 || cacheWrite < 0) return undefined;
  return usage({ input, cacheRead, cacheWrite });
}

export class CacheInspector {
  private baseline?: TokenStats;
  private previousTurn?: CacheUsage;
  private lastReport?: CacheReport;

  begin(stats: SessionStats): void {
    this.baseline = { ...stats.tokens };
  }

  finish(stats: SessionStats): CacheReport {
    if (!this.baseline && this.lastReport) return this.current(stats);
    const turn = this.baseline ? delta(stats.tokens, this.baseline) : undefined;
    this.baseline = undefined;
    const session = usage(stats.tokens);
    let changePercentagePoints: number | undefined;
    let alert: string | undefined;

    if (turn?.hitRate !== undefined && this.previousTurn?.hitRate !== undefined) {
      changePercentagePoints = Math.round((turn.hitRate - this.previousTurn.hitRate) * 1000) / 10;
      if (
        turn.promptTokens >= MIN_PROMPT_TOKENS_FOR_ALERT &&
        this.previousTurn.promptTokens >= MIN_PROMPT_TOKENS_FOR_ALERT &&
        changePercentagePoints <= -DROP_ALERT_PERCENTAGE_POINTS
      ) {
        alert = `Cache hit rate decreased ${Math.abs(changePercentagePoints).toFixed(1)} percentage points from the previous observed turn.`;
      }
    }
    if (turn && turn.promptTokens > 0) this.previousTurn = turn;

    const report: CacheReport = {
      ...(turn ? { turn } : {}),
      session,
      ...(changePercentagePoints === undefined ? {} : { changePercentagePoints }),
      ...(alert ? { alert } : {}),
    };
    this.lastReport = report;
    return report;
  }

  current(stats: SessionStats): CacheReport {
    return this.lastReport
      ? { ...this.lastReport, session: usage(stats.tokens) }
      : { session: usage(stats.tokens) };
  }
}

function formatUsage(value: CacheUsage): string {
  const rate = value.hitRate === undefined ? "n/a" : `${(value.hitRate * 100).toFixed(1)}%`;
  return `hit=${value.hitTokens.toLocaleString("en-US")} miss=${value.missTokens.toLocaleString("en-US")} rate=${rate} prompt=${value.promptTokens.toLocaleString("en-US")}`;
}

export function formatCacheReport(report: CacheReport): string {
  const lines = [
    `turn ${report.turn ? formatUsage(report.turn) : "unavailable"}`,
    `session ${formatUsage(report.session)}`,
  ];
  if (report.changePercentagePoints !== undefined) {
    const sign = report.changePercentagePoints > 0 ? "+" : "";
    lines.push(`change=${sign}${report.changePercentagePoints.toFixed(1)}pp vs previous observed turn`);
  }
  return lines.join("\n");
}
