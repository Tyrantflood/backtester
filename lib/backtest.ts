import { rsi, sma } from "@/lib/indicators";
import type { Candle } from "@/lib/parseCandles";

export type Strategy =
  | { type: "ma-cross"; fast: number; slow: number }
  | { type: "rsi"; period: number; oversold: number; overbought: number };

export type BacktestConfig = {
  strategy: Strategy;
  /** Percent below entry price, e.g. 5 = 5%. Null disables the stop. */
  stopLossPct: number | null;
  /** Percent above entry price. Null disables the target. */
  takeProfitPct: number | null;
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
};

export type BacktestStats = {
  trades: number;
  winRatePct: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  avgTradePct: number;
  buyAndHoldPct: number;
};

export type BacktestResult = { trades: Trade[]; stats: BacktestStats };

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

  let open: { index: number; price: number } | null = null;
  const close = (exitIndex: number, exitPrice: number, exitReason: ExitReason) => {
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
    });
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
      // If one bar touches both levels the order is unknowable; assume the stop hit first.
      if (stop !== null && c.low <= stop) close(i, Math.min(c.open, stop), "stop-loss");
      else if (target !== null && c.high >= target) close(i, Math.max(c.open, target), "take-profit");
    }
  }

  if (open) {
    const last = candles.length - 1;
    close(last, candles[last].close, "end-of-data");
  }

  return { trades, stats: computeStats(candles, trades) };
}

function computeStats(candles: Candle[], trades: Trade[]): BacktestStats {
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  for (const t of trades) {
    equity *= 1 + t.returnPct / 100;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, (peak - equity) / peak);
  }
  const wins = trades.filter((t) => t.returnPct > 0).length;
  const first = candles[0]?.open;
  const last = candles[candles.length - 1]?.close;
  return {
    trades: trades.length,
    winRatePct: trades.length ? (wins / trades.length) * 100 : 0,
    totalReturnPct: (equity - 1) * 100,
    maxDrawdownPct: maxDd * 100,
    avgTradePct: trades.length ? trades.reduce((a, t) => a + t.returnPct, 0) / trades.length : 0,
    buyAndHoldPct: first && last ? (last / first - 1) * 100 : 0,
  };
}
