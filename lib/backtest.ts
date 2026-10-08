import { rsi, sma } from "@/lib/indicators";
import type { Candle } from "@/lib/parseCandles";

export type Strategy =
  | { type: "ma-cross"; fast: number; slow: number }
  | { type: "rsi"; period: number; oversold: number; overbought: number };

/** Which level a candle that touches both stop and target is assumed to have hit first. */
export type SameCandleRule = "stop-first" | "target-first" | "by-candle-colour";

export type Direction = "long" | "short";

/** Which sides the strategy may trade. "both" reverses: each exit signal also opens the other side. */
export type TradeMode = Direction | "both";

/**
 * For a candle that opens between the stop and the target and then reaches both: was the
 * stop hit first? A daily candle doesn't record the order, so "by-candle-colour" guesses from
 * its shape: green is read as open -> low -> high -> close, red as open -> high -> low -> close.
 * Which level the low or high reaches depends on direction: a long's stop is below and its
 * target above, a short's the reverse.
 */
export function stopHitFirst(
  rule: SameCandleRule,
  direction: Direction,
  candle: { open: number; close: number },
): boolean {
  if (rule === "stop-first") return true;
  if (rule === "target-first") return false;
  const lowFirst = candle.close >= candle.open;
  return direction === "long" ? lowFirst : !lowFirst;
}

export type BacktestConfig = {
  strategy: Strategy;
  mode: TradeMode;
  /** Percent against the entry price (below for a long, above for a short). Null disables the stop. */
  stopLossPct: number | null;
  /** Percent in favour of the entry price (above for a long, below for a short). Null disables it. */
  takeProfitPct: number | null;
  /** Only matters when a single candle's range covers both levels. */
  sameCandle: SameCandleRule;
};

export type ExitReason = "signal" | "stop-loss" | "take-profit" | "liquidated" | "end-of-data";

export type Trade = {
  direction: Direction;
  entryIndex: number;
  exitIndex: number;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  /** Profit as a percent of the entry price; a short gains when the price falls. Floored at -100. */
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

type SideSignals = { entry: boolean[]; exit: boolean[] };
type Signals = Record<Direction, SideSignals>;

/**
 * Short signals are the mirror image of the long ones. For the crossover that is the same
 * crossings with entry and exit swapped; for RSI a short sells as RSI rises through overbought
 * and covers once it drops to oversold.
 */
function buildSignals(candles: Candle[], strategy: Strategy): Signals {
  const blank = () => new Array<boolean>(candles.length).fill(false);
  const sig: Signals = {
    long: { entry: blank(), exit: blank() },
    short: { entry: blank(), exit: blank() },
  };
  const closes = candles.map((c) => c.close);

  if (strategy.type === "ma-cross") {
    const fast = sma(closes, strategy.fast);
    const slow = sma(closes, strategy.slow);
    for (let i = 1; i < candles.length; i++) {
      const [f0, s0, f1, s1] = [fast[i - 1], slow[i - 1], fast[i], slow[i]];
      if (f0 === null || s0 === null || f1 === null || s1 === null) continue;
      const crossUp = f0 <= s0 && f1 > s1;
      const crossDown = f0 >= s0 && f1 < s1;
      sig.long.entry[i] = crossUp;
      sig.long.exit[i] = crossDown;
      sig.short.entry[i] = crossDown;
      sig.short.exit[i] = crossUp;
    }
  } else {
    const r = rsi(closes, strategy.period);
    for (let i = 1; i < candles.length; i++) {
      const [r0, r1] = [r[i - 1], r[i]];
      if (r0 === null || r1 === null) continue;
      // Entries need a fresh cross (not merely sitting beyond the level); exits are level-based.
      sig.long.entry[i] = r0 > strategy.oversold && r1 <= strategy.oversold;
      sig.long.exit[i] = r1 >= strategy.overbought;
      sig.short.entry[i] = r0 < strategy.overbought && r1 >= strategy.overbought;
      sig.short.exit[i] = r1 <= strategy.oversold;
    }
  }
  return sig;
}

type Position = { dir: Direction; index: number; price: number };

const sign = (dir: Direction) => (dir === "long" ? 1 : -1);

/**
 * What one unit of capital is worth when the position is marked at `price`. A short reaches zero at
 * double its entry price, but it is liquidated before then (see runBacktest), so this stays positive.
 */
const worth = (p: Position, price: number) => (p.dir === "long" ? price / p.price : 2 - price / p.price);

/**
 * One position at a time, all-in, long and/or short. Signals are read at a bar's close and
 * filled at the next bar's open, so no trade uses information from its own bar.
 */
export function runBacktest(candles: Candle[], cfg: BacktestConfig): BacktestResult {
  const sig = buildSignals(candles, cfg.strategy);
  const trades: Trade[] = [];
  const equity: EquityPoint[] = [];
  const canGo = (d: Direction) => cfg.mode === "both" || cfg.mode === d;

  let cash = INITIAL_CAPITAL; // account value while flat; the position is valued on top of it
  let pos: Position | null = null;
  const close = (exitIndex: number, exitPrice: number, exitReason: ExitReason, ambiguous = false) => {
    if (!pos) return;
    const returnPct = Math.max(-100, sign(pos.dir) * (exitPrice / pos.price - 1) * 100);
    trades.push({
      direction: pos.dir,
      entryIndex: pos.index,
      exitIndex,
      entryDate: candles[pos.index].date,
      exitDate: candles[exitIndex].date,
      entryPrice: pos.price,
      exitPrice,
      returnPct,
      exitReason,
      ambiguous,
    });
    cash *= 1 + returnPct / 100;
    pos = null;
  };

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    // Fill signals raised on the previous bar at this bar's open. An exit that also raises an
    // entry for the other side reverses straight away, at the same price.
    if (i > 0) {
      if (pos && sig[pos.dir].exit[i - 1]) close(i, c.open, "signal");
      if (!pos) {
        const dir: Direction | null =
          canGo("long") && sig.long.entry[i - 1] ? "long" : canGo("short") && sig.short.entry[i - 1] ? "short" : null;
        if (dir) pos = { dir, index: i, price: c.open };
      }
    }

    // Stops and targets are checked on the entry bar too, because the fill is at its open.
    if (pos) {
      const s = sign(pos.dir);
      // A short with no stop is liquidated if the price doubles: the account is gone by then.
      const stop =
        cfg.stopLossPct !== null
          ? pos.price * (1 - (s * cfg.stopLossPct) / 100)
          : pos.dir === "short"
            ? pos.price * 2
            : null;
      const target = cfg.takeProfitPct === null ? null : pos.price * (1 + (s * cfg.takeProfitPct) / 100);
      const stopReason: ExitReason = cfg.stopLossPct === null ? "liquidated" : "stop-loss";

      // A long's stop is hit by the low and its target by the high; a short's the other way round.
      const hitStop = stop !== null && (pos.dir === "long" ? c.low <= stop : c.high >= stop);
      const hitTarget = target !== null && (pos.dir === "long" ? c.high >= target : c.low <= target);
      if (hitStop || hitTarget) {
        // A gap past a level settles the order; only a candle that opens between the two
        // levels and then reaches both is genuinely ambiguous, so the chosen rule decides.
        let stopFirst = hitStop;
        let ambiguous = false;
        if (hitStop && hitTarget) {
          const gapsThroughStop = pos.dir === "long" ? c.open <= stop! : c.open >= stop!;
          const gapsThroughTarget = pos.dir === "long" ? c.open >= target! : c.open <= target!;
          if (gapsThroughStop) stopFirst = true;
          else if (gapsThroughTarget) stopFirst = false;
          else {
            ambiguous = true;
            stopFirst = stopHitFirst(cfg.sameCandle, pos.dir, c);
          }
        }
        // Gaps fill at the open when it is already beyond the level, otherwise at the level.
        if (stopFirst) {
          close(i, pos.dir === "long" ? Math.min(c.open, stop!) : Math.max(c.open, stop!), stopReason, ambiguous);
        } else {
          close(i, pos.dir === "long" ? Math.max(c.open, target!) : Math.min(c.open, target!), "take-profit", ambiguous);
        }
      }
    }

    equity.push({ date: c.date, value: pos ? cash * worth(pos, c.close) : cash });
  }

  if (pos) {
    // Closes at the last close, which is exactly where the final equity point is already marked.
    const last = candles.length - 1;
    close(last, candles[last].close, "end-of-data");
  }

  const first = candles[0]?.open;
  const benchmark = candles.map((c) => ({ date: c.date, value: INITIAL_CAPITAL * (c.close / first) }));
  return { trades, stats: computeStats(trades, equity, benchmark), equity, benchmark };
}

export function computeStats(trades: Trade[], equity: EquityPoint[], benchmark: EquityPoint[]): BacktestStats {
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
