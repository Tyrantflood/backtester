import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runBacktest, type SameCandleRule } from "@/lib/backtest";
import { sma } from "@/lib/indicators";
import { bars, cfg, fromOC, near } from "./helpers";

// ---------------------------------------------------------------------------------------------
// Floating-point noise must not decide a comparison. 0.1 + 0.1 + 0.1 is 0.30000000000000004, so
// the 3-bar average of a flat 0.1 is 0.10000000000000002: not equal to the price it averages.
// ---------------------------------------------------------------------------------------------
describe("sma is exact where it can be", () => {
  it("a period of 1 returns the input exactly, for ordinary two-decimal prices", () => {
    let seed = 9;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const prices = Array.from({ length: 5000 }, () => Math.round((50 + rnd() * 100) * 100) / 100);
    assert.deepEqual(sma(prices, 1), prices);
  });

  it("stays within 1e-12 of a direct window sum over a long series (no accumulating drift)", () => {
    const closes = Array.from({ length: 50_000 }, (_, i) => 100 + Math.sin(i / 50) * 30 + (i % 7) * 0.01);
    const out = sma(closes, 200);
    for (const i of [199, 1000, 25_000, 49_999]) {
      let s = 0;
      for (let j = i - 199; j <= i; j++) s += closes[j];
      near(out[i], s / 200, 1e-12);
    }
  });

  it("is still null until the window is full after the re-summing", () => {
    assert.deepEqual(sma([1, 2, 3, 4, 5, 6, 7], 4), [null, null, null, 2.5, 3.5, 4.5, 5.5]);
  });
});

describe("a tie between the averages is a tie, whichever way rounding falls", () => {
  const down = [0.1, 0.1, 0.1, 0.1, 0.05, 0.05]; // flat 0.1, then a drop
  const up = [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.2, 0.2]; // flat 0.1, then a rise

  it("the data really does have rounding noise (so these tests mean something)", () => {
    assert.notEqual(sma(down, 3)[3], 0.1, "3-bar average of 0.1 comes out above 0.1");
    assert.ok((sma(down, 3)[3] as number) > 0.1);
    assert.ok((sma(up, 7)[7] as number) < 0.1, "7-bar average of 0.1 comes out below 0.1");
  });

  it("a cross DOWN out of a flat stretch is found when the slow average rounds above the price", () => {
    // fast = close, slow = 3-bar mean. They are level (0.1) on bar 3, then bar 4 drops to 0.05.
    const r = runBacktest(fromOC(down, down), cfg({ type: "ma-cross", fast: 1, slow: 3 }, null, null, "stop-first", "short"));
    assert.equal(r.trades.length, 1);
    assert.deepEqual([r.trades[0].direction, r.trades[0].entryIndex], ["short", 5]); // signal on bar 4
  });

  it("a cross UP out of a flat stretch is found when the slow average rounds below the price, and there is no phantom cross before it", () => {
    // fast = close, slow = 7-bar mean. Level at 0.1 through bar 7, then bar 8 rises to 0.2.
    const r = runBacktest(fromOC(up, up), cfg({ type: "ma-cross", fast: 1, slow: 7 }, null, null, "stop-first", "long"));
    assert.equal(r.trades.length, 1);
    assert.deepEqual([r.trades[0].direction, r.trades[0].entryIndex], ["long", 9]); // signal on bar 8, not bar 7
  });

  it("a genuine difference smaller than the noise floor is not mistaken for a tie", () => {
    // 1 part in 10^9 apart is a real move, far above 10^-12.
    const closes = [100, 100, 100, 100.0000001, 99.9999999, 99, 98];
    const r = runBacktest(fromOC(closes, closes), cfg({ type: "ma-cross", fast: 1, slow: 3 }, null, null, "stop-first", "both"));
    assert.ok(r.trades.length >= 1);
  });
});

// ---------------------------------------------------------------------------------------------
// A stop that is exactly a price to the cent must be reached by a candle touching that price.
// 2.75 * (1 - 0.04) is 2.6399999999999997, so a low of exactly 2.64 used to miss it.
// ---------------------------------------------------------------------------------------------
describe("stop and target levels that are exact cent prices are reached by a candle touching them", () => {
  const longSetup: [number, number, number, number][] = [
    [1, 1.05, 0.95, 1],
    [0.9, 0.95, 0.85, 0.9],
    [0.8, 0.85, 0.75, 0.8],
    [0.9, 0.95, 0.85, 0.9], // fast crosses above slow
  ];
  const shortSetup: [number, number, number, number][] = [
    [1, 1.05, 0.95, 1],
    [1, 1.15, 0.98, 1.1],
    [1.1, 1.25, 1.08, 1.2],
    [1.2, 1.23, 1.08, 1.1], // fast crosses below slow
  ];
  const MA = { type: "ma-cross" as const, fast: 1, slow: 2 };
  const rule: SameCandleRule = "stop-first";
  const long = (bar: [number, number, number, number], sl: number | null, tp: number | null) =>
    runBacktest(bars([...longSetup, bar]), cfg(MA, sl, tp, rule, "long")).trades[0];
  const short = (bar: [number, number, number, number], sl: number | null, tp: number | null) =>
    runBacktest(bars([...shortSetup, bar]), cfg(MA, sl, tp, rule, "short")).trades[0];

  it("the arithmetic really does land a hair off (so these tests mean something)", () => {
    assert.notEqual(2.75 * (1 - 4 / 100), 2.64);
    assert.notEqual(2.75 * (1 + 4 / 100), 2.86);
    assert.notEqual(3.1 * (1 + 10 / 100), 3.41);
    assert.notEqual(5.2 * (1 - 5 / 100), 4.94);
  });

  it("long stop: quote 2.75, 4% -> a low of exactly 2.64 stops it", () => {
    const t = long([2.75, 2.8, 2.64, 2.7], 4, null);
    assert.equal(t.exitReason, "stop-loss");
    near(t.exitPrice, 2.64, 1e-9);
  });

  it("short stop: quote 2.75, 4% -> a high of exactly 2.86 stops it", () => {
    const t = short([2.75, 2.86, 2.7, 2.8], 4, null);
    assert.equal(t.exitReason, "stop-loss");
    near(t.exitPrice, 2.86, 1e-9);
  });

  it("long target: quote 3.1, 10% -> a high of exactly 3.41 hits it", () => {
    const t = long([3.1, 3.41, 3.0, 3.2], null, 10);
    assert.equal(t.exitReason, "take-profit");
    near(t.exitPrice, 3.41, 1e-9);
  });

  it("short target: quote 5.2, 5% -> a low of exactly 4.94 hits it", () => {
    const t = short([5.2, 5.3, 4.94, 5.0], null, 5);
    assert.equal(t.exitReason, "take-profit");
    near(t.exitPrice, 4.94, 1e-9);
  });

  it("a candle a full cent short of the level still does not reach it", () => {
    assert.equal(long([2.75, 2.8, 2.65, 2.7], 4, null).exitReason, "end-of-data");
    assert.equal(short([2.75, 2.85, 2.7, 2.8], 4, null).exitReason, "end-of-data");
    assert.equal(long([3.1, 3.4, 3.0, 3.2], null, 10).exitReason, "end-of-data");
    assert.equal(short([5.2, 5.3, 4.95, 5.0], null, 5).exitReason, "end-of-data");
  });

  // The gap check only decides anything when one candle reaches BOTH levels: a candle that opens
  // on or beyond a level settles the order, otherwise the same-candle rule has to guess.
  it("a candle opening exactly on the stop, then reaching the target, is a stop: no guess, whatever the rule", () => {
    // Quote 2.75, stop 4% = 2.64, target 5% ~ 2.8875. Bar 5 opens on 2.64 and runs up through the target.
    const t = runBacktest(
      bars([...longSetup, [2.75, 2.8, 2.7, 2.78], [2.64, 2.9, 2.6, 2.8]]),
      cfg(MA, 4, 5, "target-first", "long"),
    ).trades[0];
    assert.deepEqual([t.exitIndex, t.exitReason, t.ambiguous], [5, "stop-loss", false]);
    near(t.exitPrice, 2.64, 1e-9);
  });

  it("a candle opening exactly on the target, then reaching the stop, is a target: no guess, whatever the rule", () => {
    // Quote 3.1, target 10% = 3.41, stop 10% = 2.79. Bar 5 opens on 3.41 and falls through the stop.
    const t = runBacktest(
      bars([...longSetup, [3.1, 3.2, 3.05, 3.15], [3.41, 3.5, 2.7, 3.0]]),
      cfg(MA, 10, 10, "stop-first", "long"),
    ).trades[0];
    assert.deepEqual([t.exitIndex, t.exitReason, t.ambiguous], [5, "take-profit", false]);
    near(t.exitPrice, 3.41, 1e-9);
  });

  it("short: a candle opening exactly on the stop, then reaching the target, is a stop whatever the rule", () => {
    // Quote 2.75, stop 4% = 2.86, target 5% = 2.6125. Bar 5 opens on 2.86 and falls through the target.
    // The setup sits at the quote's own price level, and bar 4 closes no higher than its slow average,
    // so nothing but the stop and target can end the short.
    const setup: [number, number, number, number][] = [
      [2.5, 2.6, 2.4, 2.5],
      [2.5, 2.75, 2.45, 2.7],
      [2.7, 2.95, 2.65, 2.9],
      [2.9, 2.92, 2.65, 2.7], // fast crosses below slow
    ];
    const t = runBacktest(
      bars([...setup, [2.75, 2.8, 2.69, 2.69], [2.86, 2.9, 2.5, 2.7]]),
      cfg(MA, 4, 5, "target-first", "short"),
    ).trades[0];
    assert.deepEqual([t.exitIndex, t.exitReason, t.ambiguous], [5, "stop-loss", false]);
    near(t.exitPrice, 2.86, 1e-9);
  });

  it("short: a candle opening exactly on the target, then reaching the stop, is a target whatever the rule", () => {
    // Quote 5.2, target 5% = 4.94, stop 5% = 5.46. Bar 5 opens on 4.94 and rises through the stop.
    const setup: [number, number, number, number][] = [
      [4.9, 5.0, 4.8, 4.9],
      [4.9, 5.2, 4.85, 5.1],
      [5.1, 5.4, 5.05, 5.3],
      [5.3, 5.35, 5.05, 5.1], // fast crosses below slow
    ];
    const t = runBacktest(
      bars([...setup, [5.2, 5.3, 5.1, 5.1], [4.94, 5.5, 4.9, 5.0]]),
      cfg(MA, 5, 5, "stop-first", "short"),
    ).trades[0];
    assert.deepEqual([t.exitIndex, t.exitReason, t.ambiguous], [5, "take-profit", false]);
    near(t.exitPrice, 4.94, 1e-9);
  });

  it("the same two candles shifted one cent off the level are genuinely ambiguous and follow the rule", () => {
    const off = runBacktest(
      bars([...longSetup, [2.75, 2.8, 2.7, 2.78], [2.65, 2.9, 2.6, 2.8]]),
      cfg(MA, 4, 5, "target-first", "long"),
    ).trades[0];
    assert.deepEqual([off.exitReason, off.ambiguous], ["take-profit", true]);
  });
});
