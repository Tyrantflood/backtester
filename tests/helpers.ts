import assert from "node:assert/strict";
import type { BacktestConfig, Costs, SameCandleRule, Strategy, TradeMode } from "@/lib/backtest";
import type { Candle } from "@/lib/parseCandles";

export const near = (actual: number | null, expected: number, eps = 1e-6) => {
  assert.notEqual(actual, null);
  assert.ok(Math.abs((actual as number) - expected) < eps, `expected ${expected}, got ${actual}`);
};

export const date = (i: number) => new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);

/** Candles from explicit [open, high, low, close] rows. */
export const bars = (rows: [number, number, number, number][]): Candle[] =>
  rows.map(([open, high, low, close], i) => ({ date: date(i), open, high, low, close, volume: 1 }));

/** Candles from opens and closes; wicks are 0.1 beyond the body so they never trigger stops. */
export const fromOC = (opens: number[], closes: number[]): Candle[] =>
  bars(opens.map((o, i) => [o, Math.max(o, closes[i]) + 0.1, Math.min(o, closes[i]) - 0.1, closes[i]]));

/** fast = the close itself, slow = the 2-bar mean: the smallest crossover that is easy to hand-calculate. */
export const MA_1_2: Strategy = { type: "ma-cross", fast: 1, slow: 2 };

/** Long crossover: entry signal on bar 3 fills bar 4's open (9.6), exit signal on bar 6 fills bar 7's open (9.4). */
export const LONG_DATA = fromOC(
  [10, 9.5, 8.5, 8.7, 9.6, 10.5, 10.8, 9.4],
  [10, 9, 8, 9, 10, 11, 10, 9],
);

/** Short crossover: signal on bar 3 shorts at bar 4's open (10.8), cover signal on bar 7 fills bar 8's open (8.64). */
export const SHORT_DATA = fromOC(
  [10, 10.5, 11.5, 12, 10.8, 9.5, 8.8, 8.2, 8.64],
  [10, 11, 12, 11, 10, 9, 8, 9, 10],
);

/** A deterministic random walk of candles, for properties that must hold on arbitrary data. */
export const randomWalk = (length = 320, seed = 42): Candle[] => {
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let p = 100;
  return Array.from({ length }, (_, i): Candle => {
    const open = p;
    const close = open + (rnd() - 0.5) * 4;
    p = close;
    return { date: date(i), open, close, high: Math.max(open, close) + rnd(), low: Math.min(open, close) - rnd(), volume: 1 };
  });
};

export const cfg = (
  strategy: Strategy,
  stopLossPct: number | null = null,
  takeProfitPct: number | null = null,
  sameCandle: SameCandleRule = "stop-first",
  mode: TradeMode = "long",
  costs: Partial<Costs> = {},
): BacktestConfig => ({
  strategy,
  mode,
  stopLossPct,
  takeProfitPct,
  sameCandle,
  costs: { spreadPct: 0, slippagePct: 0, commission: 0, ...costs },
});
