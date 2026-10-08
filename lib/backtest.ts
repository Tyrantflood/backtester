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

/**
 * Trading costs. Spread and slippage are percentages of price; commission is a fixed amount of
 * account currency per order, charged when a trade is opened and again when it is closed.
 */
export type Costs = { spreadPct: number; slippagePct: number; commission: number };

export const NO_COSTS: Costs = { spreadPct: 0, slippagePct: 0, commission: 0 };

export type BacktestConfig = {
  strategy: Strategy;
  mode: TradeMode;
  /** Percent against the entry price (below for a long, above for a short). Null disables the stop. */
  stopLossPct: number | null;
  /** Percent in favour of the entry price (above for a long, below for a short). Null disables it. */
  takeProfitPct: number | null;
  /** Only matters when a single candle's range covers both levels. */
  sameCandle: SameCandleRule;
  /** Omitted means no costs. */
  costs?: Costs;
};

export type ExitReason = "signal" | "stop-loss" | "take-profit" | "liquidated" | "end-of-data";

export type Trade = {
  direction: Direction;
  entryIndex: number;
  exitIndex: number;
  entryDate: string;
  exitDate: string;
  /** Prices actually obtained: the market price moved against the trade by spread and slippage. */
  entryPrice: number;
  exitPrice: number;
  /** The quoted market prices the fills were based on. */
  marketEntryPrice: number;
  marketExitPrice: number;
  /** Net change in the account over the trade, costs included, as a percent. Cannot go below -100. */
  returnPct: number;
  /** Net profit in account currency, costs included. */
  pnl: number;
  /** What spread, slippage and commission took from this trade; zero without costs. */
  costs: number;
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
  /** Total spread, slippage and commission paid over all trades. */
  totalCosts: number;
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

/**
 * Comparisons that ignore floating-point noise: two values within one part in 10^12 count as
 * equal. Without this an average that is mathematically level with another is split by rounding
 * (3.3 against 3.3000000000000003), and a stop that is exactly a candle's high, such as 11.00
 * against 11.000000000000002, is missed. Prices to the cent hit this about one time in seven.
 */
const EPS = 1e-12;
const slack = (a: number, b: number) => EPS * Math.max(Math.abs(a), Math.abs(b));
const lte = (a: number, b: number) => a <= b + slack(a, b);
const gte = (a: number, b: number) => a >= b - slack(a, b);
const lt = (a: number, b: number) => !gte(a, b);
const gt = (a: number, b: number) => !lte(a, b);

/**
 * Reads a cost field. Empty means zero, but a number input also reports "" when the text typed
 * into it is unparseable ("1e", "--"); `badInput` marks that case so it becomes NaN, which
 * validateConfig rejects, instead of a silent zero.
 */
export function parseCost(raw: string, badInput = false): number {
  if (badInput) return NaN;
  return raw.trim() === "" ? 0 : Number(raw);
}

/**
 * Reads an optional field (stop loss, take profit): empty means disabled (null). As with
 * parseCost, `badInput` text becomes NaN so validateConfig rejects it instead of disabling it.
 */
export function parseOptional(raw: string, badInput = false): number | null {
  if (badInput) return NaN;
  return raw.trim() === "" ? null : Number(raw);
}

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
    if (v !== null && !(v > 0)) return `${label} must be a number greater than 0 (or left empty to disable).`;
  }
  if (cfg.stopLossPct !== null && cfg.stopLossPct >= 100) return "Stop loss must be below 100%.";
  const c = cfg.costs ?? NO_COSTS;
  for (const [label, v] of [
    ["Spread", c.spreadPct],
    ["Slippage", c.slippagePct],
    ["Commission", c.commission],
  ] as const) {
    if (!(Number.isFinite(v) && v >= 0)) return `${label} must be a number, 0 or more.`;
  }
  if (c.spreadPct / 2 + c.slippagePct >= 100) return "Spread and slippage are too large: a fill would lose the whole price.";
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
      const crossUp = lte(f0, s0) && gt(f1, s1);
      const crossDown = gte(f0, s0) && lt(f1, s1);
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
      sig.long.entry[i] = gt(r0, strategy.oversold) && lte(r1, strategy.oversold);
      sig.long.exit[i] = gte(r1, strategy.overbought);
      sig.short.entry[i] = lt(r0, strategy.overbought) && gte(r1, strategy.overbought);
      sig.short.exit[i] = lte(r1, strategy.oversold);
    }
  }
  return sig;
}

type Position = {
  dir: Direction;
  index: number;
  /** The price actually obtained on entry (market price after spread and slippage). */
  price: number;
  /** The quoted market price the entry was based on. */
  market: number;
  /** Account value just before the entry, and what was left to invest after its commission. */
  before: number;
  capital: number;
};

const sign = (dir: Direction) => (dir === "long" ? 1 : -1);

/** What one unit of capital is worth when the position is marked at `price`. */
const worth = (p: Position, price: number) => (p.dir === "long" ? price / p.price : 2 - price / p.price);

/**
 * The market price at which covering a short leaves nothing, after the cover's spread, slippage
 * and commission. Solving capital * (2 - cover / entryFill) - commission = 0, with the cover
 * filled at price * (1 + edge), gives price = entryFill * (2 - commission / capital) / (1 + edge).
 *
 * `capital` is what was left to invest AFTER the entry commission (p.capital), not the account
 * before it: with a $10,000 account and $100 commission it is 9,900, so the level for a short
 * entered at 10 is 10 * (2 - 100 / 9900) = 19.89899, not 19.9. Covering at 19.9 would already
 * leave the account $1 short.
 *
 * With no costs that is exactly double the entry. An account with nothing to invest is already
 * gone, so its level is the entry price itself.
 */
function liquidationPrice(p: Position, commission: number, edge: number): number {
  return p.capital > 0 ? (p.price * (2 - commission / p.capital)) / (1 + edge) : p.market;
}

/**
 * One position at a time, all-in, long and/or short. Signals are read at a bar's close and
 * filled at the next bar's open, so no trade uses information from its own bar.
 *
 * Costs always work against the trade. Every fill moves the market price by the same adverse
 * amount: buys (a long entry, a short cover) pay more, sells (a long exit, a short entry)
 * receive less. Commission is taken from the account at each fill.
 *
 * Stops and targets are measured from the quoted entry price, not the fill. That keeps them
 * independent of costs: with or without costs the same candle triggers the same exit, so costs
 * only change what each trade earns, never which trades happen. The exit fill then pays costs.
 * A short also has a liquidation level (see liquidationPrice) that can come before its stop.
 */
export function runBacktest(candles: Candle[], cfg: BacktestConfig): BacktestResult {
  const sig = buildSignals(candles, cfg.strategy);
  const costs = cfg.costs ?? NO_COSTS;
  const edge = (costs.spreadPct / 2 + costs.slippagePct) / 100; // adverse move per fill, as a fraction of price
  const trades: Trade[] = [];
  const equity: EquityPoint[] = [];
  const canGo = (d: Direction) => cfg.mode === "both" || cfg.mode === d;

  let cash = INITIAL_CAPITAL; // account value while flat
  let pos: Position | null = null;

  const openPosition = (dir: Direction, index: number, market: number): Position => ({
    dir,
    index,
    market,
    price: market * (1 + sign(dir) * edge),
    before: cash,
    capital: Math.max(0, cash - costs.commission),
  });

  const close = (exitIndex: number, market: number, exitReason: ExitReason, ambiguous = false) => {
    if (!pos) return;
    const exitPrice = market * (1 - sign(pos.dir) * edge);
    const after = Math.max(0, pos.capital * worth(pos, exitPrice) - costs.commission);
    // The same trade with no costs at all, for measuring what the costs took.
    const frictionless =
      pos.dir === "long" ? pos.before * (market / pos.market) : Math.max(0, pos.before * (2 - market / pos.market));
    trades.push({
      direction: pos.dir,
      entryIndex: pos.index,
      exitIndex,
      entryDate: candles[pos.index].date,
      exitDate: candles[exitIndex].date,
      entryPrice: pos.price,
      exitPrice,
      marketEntryPrice: pos.market,
      marketExitPrice: market,
      // With nothing to trade (the account was wiped out earlier) there is no return to report.
      returnPct: pos.before > 0 ? (after / pos.before - 1) * 100 : 0,
      pnl: after - pos.before,
      costs: frictionless - after,
      exitReason,
      ambiguous,
    });
    cash = after;
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
        if (dir) pos = openPosition(dir, i, c.open);
      }
    }

    // Stops and targets are checked on the entry bar too, because the fill is at its open.
    if (pos) {
      const s = sign(pos.dir);
      const statedStop = cfg.stopLossPct === null ? null : pos.market * (1 - (s * cfg.stopLossPct) / 100);
      const target = cfg.takeProfitPct === null ? null : pos.market * (1 + (s * cfg.takeProfitPct) / 100);
      // A short can lose more than its account, so the account's end is a stop of its own. It is
      // the effective stop when no stop is set, or when the stated one lies beyond it.
      const liquidation = pos.dir === "short" ? liquidationPrice(pos, costs.commission, edge) : null;
      const liquidates = liquidation !== null && (statedStop === null || liquidation < statedStop);
      const stop = liquidates ? liquidation : statedStop;
      const stopReason: ExitReason = liquidates ? "liquidated" : "stop-loss";

      // A long's stop is hit by the low and its target by the high; a short's the other way round.
      const hitStop = stop !== null && (pos.dir === "long" ? lte(c.low, stop) : gte(c.high, stop));
      const hitTarget = target !== null && (pos.dir === "long" ? gte(c.high, target) : lte(c.low, target));
      if (hitStop || hitTarget) {
        // A gap past a level settles the order; only a candle that opens between the two
        // levels and then reaches both is genuinely ambiguous, so the chosen rule decides.
        let stopFirst = hitStop;
        let ambiguous = false;
        if (hitStop && hitTarget) {
          const gapsThroughStop = pos.dir === "long" ? lte(c.open, stop!) : gte(c.open, stop!);
          const gapsThroughTarget = pos.dir === "long" ? gte(c.open, target!) : lte(c.open, target!);
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

    // Open positions are marked at the market close; exit costs are only charged when they close.
    equity.push({ date: c.date, value: pos ? pos.capital * worth(pos, c.close) : cash });
  }

  if (pos) {
    // Close at the last close, and make the final equity point the account after exit costs.
    const last = candles.length - 1;
    close(last, candles[last].close, "end-of-data");
    equity[last].value = cash;
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
    totalCosts: trades.reduce((a, t) => a + t.costs, 0),
  };
}
