import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Trade } from "@/lib/backtest";
import { tradesInRange } from "@/lib/visibleTrades";

/** Only the indices matter to the selector. */
const trade = (entryIndex: number, exitIndex: number): Trade =>
  ({ entryIndex, exitIndex, direction: "long" }) as unknown as Trade;
const span = (ts: Trade[]) => ts.map((t) => [t.entryIndex, t.exitIndex]);

//   bars:   0    5    10   15   20   25   30
//   trades:   (2,4)  (6,9)  (12,12)  (15,20)  (25,30)
const trades = [trade(2, 4), trade(6, 9), trade(12, 12), trade(15, 20), trade(25, 30)];
const ALL = [[2, 4], [6, 9], [12, 12], [15, 20], [25, 30]];

describe("tradesInRange", () => {
  it("an unbounded window returns every trade", () => {
    assert.deepEqual(span(tradesInRange(trades, -Infinity, Infinity, 100)), ALL);
  });

  it("returns only trades that overlap the window", () => {
    assert.deepEqual(span(tradesInRange(trades, 5, 13, 100)), [[6, 9], [12, 12]]);
  });

  it("a window touching a trade's exit or entry bar includes it (both ends are inclusive)", () => {
    assert.deepEqual(span(tradesInRange(trades, 4, 6, 100)), [[2, 4], [6, 9]]);
  });

  it("a window one bar short of touching it excludes it", () => {
    assert.deepEqual(span(tradesInRange(trades, 4.5, 5.5, 100)), []);
    assert.deepEqual(span(tradesInRange(trades, 21, 24, 100)), []);
  });

  it("fractional window edges, as the chart reports them, behave", () => {
    assert.deepEqual(span(tradesInRange(trades, 9.2, 12.4, 100)), [[12, 12]]); // (6,9) ended before 9.2
    assert.deepEqual(span(tradesInRange(trades, 8.9, 12.4, 100)), [[6, 9], [12, 12]]);
  });

  it("a trade that spans the whole window is included even though neither end is inside it", () => {
    assert.deepEqual(span(tradesInRange(trades, 16, 18, 100)), [[15, 20]]);
  });

  it("a window before the first trade or after the last returns nothing", () => {
    assert.deepEqual(tradesInRange(trades, -50, 1, 100), []);
    assert.deepEqual(tradesInRange(trades, 31, 99, 100), []);
  });

  it("an inverted window returns nothing rather than throwing", () => {
    assert.deepEqual(tradesInRange(trades, 20, 5, 100), []);
  });

  it("no trades is fine", () => {
    assert.deepEqual(tradesInRange([], -Infinity, Infinity, 10), []);
  });

  it("keeps the MOST RECENT trades when more than the cap are in view", () => {
    assert.deepEqual(span(tradesInRange(trades, -Infinity, Infinity, 2)), [[15, 20], [25, 30]]);
    assert.deepEqual(span(tradesInRange(trades, 0, 13, 1)), [[12, 12]]);
  });

  it("a cap of zero returns nothing", () => {
    assert.deepEqual(tradesInRange(trades, -Infinity, Infinity, 0), []);
  });

  it("a trade entered and exited on the same bar is found on that bar only", () => {
    assert.deepEqual(span(tradesInRange(trades, 12, 12, 100)), [[12, 12]]);
    assert.deepEqual(span(tradesInRange(trades, 13, 14, 100)), []);
  });

  it("matches a brute-force filter on random trades and windows", () => {
    let seed = 5;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let round = 0; round < 300; round++) {
      // Sequential, non-overlapping trades, as the engine produces (a reversal can share a bar).
      const list: Trade[] = [];
      let at = 0;
      const count = Math.floor(rnd() * 60);
      for (let k = 0; k < count; k++) {
        const entry = at + Math.floor(rnd() * 4);
        const exit = entry + Math.floor(rnd() * 5);
        list.push(trade(entry, exit));
        at = exit;
      }
      const from = rnd() * (at + 10) - 5;
      const to = from + rnd() * 40;
      const max = 1 + Math.floor(rnd() * 12);
      const expected = list.filter((t) => t.exitIndex >= from && t.entryIndex <= to).slice(-max);
      assert.deepEqual(tradesInRange(list, from, to, max), expected, `round ${round}: [${from}, ${to}] max ${max}`);
    }
  });
});
