import { rsi, sma } from "@/lib/indicators";
import type { Candle } from "@/lib/parseCandles";

export type Strategy =
  | { type: "ma-cross"; fast: number; slow: number }
  | { type: "rsi"; period: number; oversold: number; overbought: number };

/** Which level a candle that touches both stop and target is assumed to have hit first. */
export type SameCandleRule = "stop-first" | "target-first" | "by-candle-colour";

export type BacktestConfig = {
  strategy: Strategy;
  /** Percent below entry price, e.g. 5 = 5%. Null disables the stop. */
  stopLossPct: number | null;
  /** Percent above entry price. Null disables the target. */
  takeProfitPct: number | null;
  /** Only matters when a single candle's range covers both levels. */
  sameCandle: SameCandleRule;
};

export type ExitReason = "signal" | "stop-loss" | "take-profit" | "end-of-data";

export type Trade = {
  entryIndex: number;
  exitIndex: number;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  returnPct: number;
  exitReason: ExitReason;
  /** True when this candle touched both stop and target, so the exit order was an assumption. */
  ambiguous: boolean;
};

export type BacktestStats = {
  trades: number;
  winRatePct: number;
  /** Compounded return of all closed trades; equals the final equity change. */
  netReturnPct: number;
  netProfit: number;
  finalEquity: number;
  /** Gross profit / gross loss over trade returns. Infinity with no losing trade, null with no trades. */
  profitFactor: number | null;
  /** Realised reward-to-risk: average winning trade / average losing trade. Null without both. */
  avgRewardRisk: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  /** Largest peak-to-trough fall of the bar-by-bar equity curve. */
  maxDrawdownPct: number;
  buyAndHoldPct: number;
};

export type EquityPoint = { date: string; value: number };

export type BacktestResult = {
  trades: Trade[];
  stats: BacktestStats;
  /** Account value after each candle, marked to the close while a position is open. */
  equity: EquityPoint[];
  /** Same capital bought at the first open and held. */
  benchmark: EquityPoint[];
};

export const INITIAL_CAPITAL = 10_000;

/** Returns an error message, or null when the config is runnable. */
export function validateConfig(cfg: BacktestConfig): string | null {
  const s = cfg.strategy;
  const isInt = (n: number) => Number.isInteger(n) && n >= 1;
  if (s.type === "ma-cross") {
    if (!isInt(s.fast) || !isInt(s.slow)) return "Fast and slow periods must be whole numbers of at least 1.";
    if (s.fast >= s.slow) return "Fast period must be shorter than slow period.";
  } else {
    if (!isInt(s.period) || s.period < 2) return "RSI period must be a whole number of at least 2.";
    if (!(s.oversold >= 0 && s.overbought <= 100 && s.oversold < s.overbought)) {
      return "Oversold must be below overbought, both between 0 and 100.";
    }
  }
  for (const [label, v] of [
    ["Stop loss", cfg.stopLossPct],
    ["Take profit", cfg.takeProfitPct],
  ] as const) {
    if (v !== null && !(v > 0)) return `${label} must be greater than 0 (or left empty to disable).`;
  }
  if (cfg.stopLossPct !== null && cfg.stopLossPct >= 100) return "Stop loss must be below 100%.";
  return null;
}

type Signals = { entry: boolean[]; exit: boolean[] };

function buildSignals(candles: Candle[], strategy: Strategy): Signals {
  const closes = candles.map((c) => c.close);
  const entry = new Array<boolean>(candles.length).fill(false);
  const exit = new Array<boolean>(candles.length).fill(false);

  if (strategy.type === "ma-cross") {
    const fast = sma(closes, strategy.fast);
    const slow = sma(closes, strategy.slow);
    for (let i = 1; i < candles.length; i++) {
      const [f0, s0, f1, s1] = [fast[i - 1], slow[i - 1], fast[i], slow[i]];
      if (f0 === null || s0 === null || f1 === null || s1 === null) continue;
      entry[i] = f0 <= s0 && f1 > s1;
      exit[i] = f0 >= s0 && f1 < s1;
    }
  } else {
    const r = rsi(closes, strategy.period);
    for (let i = 1; i < candles.length; i++) {
      const [r0, r1] = [r[i - 1], r[i]];
      if (r0 === null || r1 === null) continue;
      // Enter as RSI falls through oversold (not while it merely sits there); exit once overbought.
      entry[i] = r0 > strategy.oversold && r1 <= strategy.oversold;
      exit[i] = r1 >= strategy.overbought;
    }
  }
  return { entry, exit };
}

/**
 * Long-only, one position at a time, all-in. Signals are read at a bar's close and
 * filled at the next bar's open, so no trade uses information from its own bar.
 */
export function runBacktest(candles: Candle[], cfg: BacktestConfig): BacktestResult {
  const { entry, exit } = buildSignals(candles, cfg.strategy);
  const trades: Trade[] = [];
  const equity: EquityPoint[] = [];

  let cash = INITIAL_CAPITAL; // account value while flat; the position is valued on top of it
  let open: { index: number; price: number } | null = null;
  const close = (exitIndex: number, exitPrice: number, exitReason: ExitReason, ambiguous = false) => {
    if (!open) return;
    trades.push({
      entryIndex: open.index,
      exitIndex,
      entryDate: candles[open.index].date,
      exitDate: candles[exitIndex].date,
      entryPrice: open.price,
      exitPrice,
      returnPct: (exitPrice / open.price - 1) * 100,
      exitReason,
      ambiguous,
    });
    cash *= exitPrice / open.price;
    open = null;
  };

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    // Fill signals raised on the previous bar at this bar's open.
    if (open && exit[i - 1]) close(i, c.open, "signal");
    else if (!open && i > 0 && entry[i - 1]) open = { index: i, price: c.open };

    // Stops and targets are checked on the entry bar too, because the fill is at its open.
    if (open) {
      const stop = cfg.stopLossPct === null ? null : open.price * (1 - cfg.stopLossPct / 100);
      const target = cfg.takeProfitPct === null ? null : open.price * (1 + cfg.takeProfitPct / 100);
      const hitStop = stop !== null && c.low <= stop;
      const hitTarget = target !== null && c.high >= target;
      if (hitStop || hitTarget) {
        // A gap past a level settles the order; only a candle that opens between the two
        // levels and then reaches both is genuinely ambiguous, so the chosen rule decides.
        let stopFirst = hitStop;
        let ambiguous = false;
        if (hitStop && hitTarget) {
          if (c.open <= stop!) stopFirst = true;
          else if (c.open >= target!) stopFirst = false;
          else {
            ambiguous = true;
            // Bullish candle: assume it dipped before it rallied; bearish: the reverse.
            stopFirst =
              cfg.sameCandle === "stop-first" || (cfg.sameCandle === "by-candle-colour" && c.close >= c.open);
          }
        }
        if (stopFirst) close(i, Math.min(c.open, stop!), "stop-loss", ambiguous);
        else close(i, Math.max(c.open, target!), "take-profit", ambiguous);
      }
    }

    equity.push({ date: c.date, value: open ? cash * (c.close / open.price) : cash });
  }

  if (open) {
    // Closes at the last close, which is exactly where the final equity point is already marked.
    const last = candles.length - 1;
    close(last, candles[last].close, "end-of-data");
  }

  const first = candles[0]?.open;
  const benchmark = candles.map((c) => ({ date: c.date, value: INITIAL_CAPITAL * (c.close / first) }));
  return { trades, stats: computeStats(trades, equity, benchmark), equity, benchmark };
}

function computeStats(trades: Trade[], equity: EquityPoint[], benchmark: EquityPoint[]): BacktestStats {
  let peak = INITIAL_CAPITAL;
  let maxDd = 0;
  for (const p of equity) {
    peak = Math.max(peak, p.value);
    maxDd = Math.max(maxDd, (peak - p.value) / peak);
  }

  const wins = trades.filter((t) => t.returnPct > 0);
  const losses = trades.filter((t) => t.returnPct < 0);
  const sum = (ts: Trade[]) => ts.reduce((a, t) => a + t.returnPct, 0);
  const avgWin = wins.length ? sum(wins) / wins.length : null;
  const avgLoss = losses.length ? Math.abs(sum(losses)) / losses.length : null;
  const grossLoss = Math.abs(sum(losses));

  const finalEquity = equity.length ? equity[equity.length - 1].value : INITIAL_CAPITAL;
  const heldEnd = benchmark.length ? benchmark[benchmark.length - 1].value : INITIAL_CAPITAL;
  return {
    trades: trades.length,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : 0,
    netReturnPct: (finalEquity / INITIAL_CAPITAL - 1) * 100,
    netProfit: finalEquity - INITIAL_CAPITAL,
    finalEquity,
    profitFactor: trades.length === 0 ? null : grossLoss === 0 ? (wins.length ? Infinity : null) : sum(wins) / grossLoss,
    avgRewardRisk: avgWin !== null && avgLoss !== null ? avgWin / avgLoss : null,
    avgWinPct: avgWin,
    avgLossPct: avgLoss,
    maxDrawdownPct: maxDd * 100,
    buyAndHoldPct: (heldEnd / INITIAL_CAPITAL - 1) * 100,
  };
}
