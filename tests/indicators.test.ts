import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rsi, sma } from "@/lib/indicators";

const near = (actual: number | null, expected: number, eps = 1e-9) => {
  assert.notEqual(actual, null);
  assert.ok(Math.abs((actual as number) - expected) < eps, `expected ${expected}, got ${actual}`);
};

describe("sma", () => {
  it("averages the trailing window and is null until the window is full", () => {
    // (1+2+3)/3 = 2, (2+3+4)/3 = 3, (3+4+5)/3 = 4
    assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  });

  it("first value lands on index period-1, not period", () => {
    const out = sma([2, 4, 6, 8], 2);
    assert.equal(out[0], null);
    assert.equal(out[1], 3); // (2+4)/2
  });

  it("drops the oldest value as the window slides", () => {
    // Window of 2 over [10, 0, 0]: (10+0)/2 = 5, then 10 must have left: (0+0)/2 = 0
    assert.deepEqual(sma([10, 0, 0], 2), [null, 5, 0]);
  });

  it("period 1 returns the input", () => {
    assert.deepEqual(sma([3, 1, 4], 1), [3, 1, 4]);
  });

  it("period equal to length gives a single value at the end", () => {
    assert.deepEqual(sma([1, 2, 3], 3), [null, null, 2]);
  });

  it("period longer than the data is all null", () => {
    assert.deepEqual(sma([1, 2], 3), [null, null]);
  });

  it("output length always matches input", () => {
    assert.equal(sma([], 3).length, 0);
    assert.equal(sma([1, 2, 3, 4, 5, 6, 7], 4).length, 7);
  });
});

describe("rsi (Wilder)", () => {
  it("matches a hand calculation, period 2", () => {
    // closes 10,11,10,12,11 -> changes +1,-1,+2,-1
    // seed (first 2 changes): gain = 1/2 = 0.5, loss = 1/2 = 0.5 -> RS 1 -> RSI 50
    // +2: gain = (0.5*1+2)/2 = 1.25, loss = (0.5*1+0)/2 = 0.25 -> RS 5 -> 100-100/6
    // -1: gain = (1.25*1+0)/2 = 0.625, loss = (0.25*1+1)/2 = 0.625 -> RSI 50
    const out = rsi([10, 11, 10, 12, 11], 2);
    assert.equal(out[0], null);
    assert.equal(out[1], null);
    near(out[2], 50);
    near(out[3], 100 - 100 / 6);
    near(out[4], 50);
  });

  it("first value lands on index `period`, which needs period+1 closes", () => {
    const out = rsi([1, 2, 3, 4, 5, 6], 3);
    assert.deepEqual(out.map((v) => v !== null), [false, false, false, true, true, true]);
    // Exactly `period` closes is not enough: only period-1 changes exist.
    assert.deepEqual(rsi([1, 2, 3], 3), [null, null, null]);
  });

  it("is 100 for a pure rise, 0 for a pure fall, 50 for a flat series", () => {
    assert.deepEqual(rsi([1, 2, 3, 4], 2).slice(2), [100, 100]);
    assert.deepEqual(rsi([4, 3, 2, 1], 2).slice(2), [0, 0]);
    assert.deepEqual(rsi([5, 5, 5, 5], 2).slice(2), [50, 50]);
  });

  it("stays within 0-100", () => {
    let seed = 11;
    const closes = Array.from({ length: 200 }, () => (seed = (seed * 16807) % 2147483647) / 1e7);
    for (const v of rsi(closes, 14)) if (v !== null) assert.ok(v >= 0 && v <= 100);
  });
});

describe("no look-ahead in indicators", () => {
  // The value at bar i must be identical whether or not later bars exist.
  const walk = (() => {
    let seed = 5;
    let p = 100;
    return Array.from({ length: 120 }, () => (p += ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 4));
  })();

  for (const [name, fn] of [
    ["sma(10)", (v: number[]) => sma(v, 10)],
    ["rsi(14)", (v: number[]) => rsi(v, 14)],
  ] as const) {
    it(`${name} on a prefix equals the same bars of the full series`, () => {
      const full = fn(walk);
      for (const cut of [20, 37, 80]) {
        assert.deepEqual(fn(walk.slice(0, cut)), full.slice(0, cut), `cut at ${cut}`);
      }
    });

    it(`${name} ignores changes to future bars`, () => {
      const changed = [...walk.slice(0, 60), ...walk.slice(60).map((v) => v * 3 + 50)];
      assert.deepEqual(fn(changed).slice(0, 60), fn(walk).slice(0, 60));
    });
  }
});
