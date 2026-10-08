import assert from "node:assert/strict";
import type { BacktestConfig, SameCandleRule, Strategy, TradeMode } from "@/lib/backtest";
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

export const cfg = (
  strategy: Strategy,
  stopLossPct: number | null = null,
  takeProfitPct: number | null = null,
  sameCandle: SameCandleRule = "stop-first",
  mode: TradeMode = "long",
): BacktestConfig => ({ strategy, mode, stopLossPct, takeProfitPct, sameCandle });
