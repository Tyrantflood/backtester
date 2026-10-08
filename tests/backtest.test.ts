import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  INITIAL_CAPITAL,
  computeStats,
  runBacktest,
  stopHitFirst,
  validateConfig,
  type BacktestConfig,
  type SameCandleRule,
  type Strategy,
  type Trade,
} from "@/lib/backtest";
import type { Candle } from "@/lib/parseCandles";

const near = (actual: number | null, expected: number, eps = 1e-6) => {
  assert.notEqual(actual, null);
  assert.ok(Math.abs((actual as number) - expected) < eps, `expected ${expected}, got ${actual}`);
};

const date = (i: number) => new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);

/** Candles from explicit [open, high, low, close] rows. */
const bars = (rows: [number, number, number, number][]): Candle[] =>
  rows.map(([open, high, low, close], i) => ({ date: date(i), open, high, low, close, volume: 1 }));

/** Candles from opens and closes; wicks are 0.1 beyond the body so they never trigger stops. */
const fromOC = (opens: number[], closes: number[]): Candle[] =>
  bars(opens.map((o, i) => [o, Math.max(o, closes[i]) + 0.1, Math.min(o, closes[i]) - 0.1, closes[i]]));

const MA_1_2: Strategy = { type: "ma-cross", fast: 1, slow: 2 }; // fast = the close itself, slow = 2-bar mean

const cfg = (
  strategy: Strategy,
  stopLossPct: number | null = null,
  takeProfitPct: number | null = null,
  sameCandle: SameCandleRule = "stop-first",
): BacktestConfig => ({ strategy, stopLossPct, takeProfitPct, sameCandle });

// ---------------------------------------------------------------------------------------------
// Timing: signal on one bar, fill on the next. Opens differ from closes so a fill at the wrong
// price or bar is visible.
//
//   i      0    1    2    3    4     5     6     7
//   close  10   9    8    9    10    11    10    9
//   open   10   9.5  8.5  8.7  9.6   10.5  10.8  9.4
//   slow   -    9.5  8.5  8.5  9.5   10.5  10.5  9.5     (2-bar mean of closes)
//
// Entry signal: fast crosses above slow. At i=3 fast 9 > 8.5 having been 8 <= 8.5 at i=2.
// Exit signal:  fast crosses below slow. At i=6 fast 10 < 10.5 having been 11 >= 10.5 at i=5.
// ---------------------------------------------------------------------------------------------
const TIMING = fromOC(
  [10, 9.5, 8.5, 8.7, 9.6, 10.5, 10.8, 9.4],
  [10, 9, 8, 9, 10, 11, 10, 9],
);

describe("signal timing and fills (look-ahead / off-by-one)", () => {
  const r = runBacktest(TIMING, cfg(MA_1_2));

  it("takes one trade", () => assert.equal(r.trades.length, 1));

  it("enters on the candle AFTER the signal, at that candle's open", () => {
    const t = r.trades[0];
    assert.equal(t.entryIndex, 4, "signal was on bar 3, fill must be bar 4");
    assert.equal(t.entryPrice, 9.6, "bar 4 open");
    assert.notEqual(t.entryPrice, TIMING[3].close, "must not fill at the signal bar's close");
    assert.notEqual(t.entryPrice, TIMING[3].open, "must not fill at the signal bar's open");
    assert.equal(t.entryDate, date(4));
  });

  it("exits on the candle AFTER the exit signal, at that candle's open", () => {
    const t = r.trades[0];
    assert.equal(t.exitIndex, 7, "exit signal was on bar 6, fill must be bar 7");
    assert.equal(t.exitPrice, 9.4, "bar 7 open");
    assert.equal(t.exitReason, "signal");
    assert.equal(t.exitDate, date(7));
  });

  it("computes the return from the actual fills", () => {
    near(r.trades[0].returnPct, (9.4 / 9.6 - 1) * 100); // -2.0833%
  });

  it("a signal on the very last candle never trades (there is no next open)", () => {
    // Same cross at i=3 as above, but the data stops there.
    const last = fromOC([10, 9, 8, 8.5], [10, 9, 8, 9]);
    const res = runBacktest(last, cfg(MA_1_2));
    assert.equal(res.trades.length, 0);
    assert.ok(res.equity.every((p) => p.value === INITIAL_CAPITAL));
  });

  it("a position still open at the end is closed at the final close, not dropped", () => {
    const res = runBacktest(TIMING.slice(0, 6), cfg(MA_1_2)); // entered on bar 4, no exit signal yet
    assert.equal(res.trades.length, 1);
    assert.equal(res.trades[0].exitReason, "end-of-data");
    assert.equal(res.trades[0].exitIndex, 5);
    assert.equal(res.trades[0].exitPrice, 11); // bar 5 close
  });
});

describe("crossover boundaries", () => {
  it("equality is not a cross; the entry fires once fast is strictly above slow", () => {
    // closes 10,9,9,10,10.5 -> slow(2): -,9.5,9,9.5,10.25
    // i=2: fast 9 == slow 9 -> NOT above, no entry. i=3: fast was 9 <= 9, now 10 > 9.5 -> entry.
    const res = runBacktest(fromOC([10, 9, 9, 9.7, 10.2], [10, 9, 9, 10, 10.5]), cfg(MA_1_2));
    assert.equal(res.trades.length, 1);
    assert.equal(res.trades[0].entryIndex, 4);
    assert.equal(res.trades[0].entryPrice, 10.2);
  });

  it("no signal can fire before both averages exist", () => {
    // slow(2) first exists at i=1, so the earliest comparable pair is i=1 vs i=2.
    const res = runBacktest(fromOC([1, 2, 3, 4], [1, 2, 3, 4]), cfg(MA_1_2));
    assert.equal(res.trades.length, 0); // always above, never crossed
  });
});

// ---------------------------------------------------------------------------------------------
// RSI(2), oversold 30, overbought 70, hand-calculated:
//   close  10  11  12   11   10   9     10    12     12
//   RSI    -   -   100  50   25   12.5  56.25 85.45  ...
// Entry when RSI falls THROUGH 30: 50 -> 25 at i=4. i=5 (12.5) is already below, so no new cross.
// Exit when RSI >= 70: first at i=7 (85.45).
// ---------------------------------------------------------------------------------------------
describe("RSI strategy", () => {
  const RSI: Strategy = { type: "rsi", period: 2, oversold: 30, overbought: 70 };
  const data = fromOC(
    [10, 10.5, 11.5, 11.5, 10.5, 9.5, 9.2, 10.5, 12.5],
    [10, 11, 12, 11, 10, 9, 10, 12, 12],
  );

  it("enters the bar after RSI crosses below oversold and exits the bar after it reaches overbought", () => {
    const res = runBacktest(data, cfg(RSI));
    assert.equal(res.trades.length, 1);
    const t = res.trades[0];
    assert.equal(t.entryIndex, 5, "signal at i=4, fill at i=5");
    assert.equal(t.entryPrice, 9.5);
    assert.equal(t.exitIndex, 8, "signal at i=7, fill at i=8");
    assert.equal(t.exitPrice, 12.5);
    near(t.returnPct, (12.5 / 9.5 - 1) * 100);
  });

  it("does not buy just because RSI sits below oversold (needs a fresh cross)", () => {
    // Falling every bar: RSI is 0 from its first value, never crossing down through 30.
    const res = runBacktest(fromOC([10, 9, 8, 7, 6, 5], [10, 9, 8, 7, 6, 5]), cfg(RSI));
    assert.equal(res.trades.length, 0);
  });

  it("does not sell on an overbought reading while flat", () => {
    // RSI is 100 at i=2 before any entry; that must not create a trade.
    const res = runBacktest(data.slice(0, 4), cfg(RSI));
    assert.equal(res.trades.length, 0);
  });
});

// ---------------------------------------------------------------------------------------------
// Stops and targets. A MA(1,2) entry signal at i=3 fills on bar 4 at its open, 10, so with 10%
// levels: stop = 9, target = 11. Bars 0-3 are the setup; the tests supply bar 4 onward.
// ---------------------------------------------------------------------------------------------
describe("stop loss and take profit", () => {
  const setup: [number, number, number, number][] = [
    [10, 10.5, 9.5, 10],
    [9, 9.5, 8.5, 9],
    [8, 8.5, 7.5, 8],
    [9, 9.5, 8.5, 9], // fast crosses above slow here
  ];
  const run = (
    next: [number, number, number, number][],
    sl: number | null = 10,
    tp: number | null = 10,
    rule: SameCandleRule = "stop-first",
  ) => runBacktest(bars([...setup, ...next]), cfg(MA_1_2, sl, tp, rule)).trades;

  it("levels come from the entry fill, not the signal bar's close", () => {
    // Stop is 9 (10% under 10). If it were based on the signal close of 9 it would be 8.1 and
    // this 8.95 low would not stop us out.
    const [t] = run([[10, 10.1, 8.95, 9.6]]);
    assert.equal(t.exitReason, "stop-loss");
    assert.equal(t.exitPrice, 9);
  });

  it("a low exactly at the stop triggers it (<=), a low one tick above does not", () => {
    assert.equal(run([[10, 10.2, 9.0, 9.5]])[0].exitReason, "stop-loss");
    assert.equal(run([[10, 10.2, 9.01, 9.5]])[0].exitReason, "end-of-data");
  });

  it("a high exactly at the target triggers it (>=), a high one tick below does not", () => {
    const hit = run([[10, 11.0, 9.5, 10.5]])[0];
    assert.equal(hit.exitReason, "take-profit");
    assert.equal(hit.exitPrice, 11);
    assert.equal(run([[10, 10.99, 9.5, 10.5]])[0].exitReason, "end-of-data");
  });

  it("is checked on the entry candle itself, since the fill is at its open", () => {
    const [t] = run([[10, 10.2, 8.5, 9.5]]);
    assert.equal(t.entryIndex, 4);
    assert.equal(t.exitIndex, 4);
    assert.equal(t.exitPrice, 9);
    near(t.returnPct, -10);
  });

  it("is checked on later candles too", () => {
    const [t] = run([
      [10, 10.3, 9.8, 10.1],
      [10.1, 10.2, 8.9, 9.0],
    ]);
    assert.equal(t.exitIndex, 5);
    assert.equal(t.exitReason, "stop-loss");
  });

  it("a gap through the stop fills at the open, not the stop price", () => {
    const [t] = run([
      [10, 10.2, 9.9, 10],
      [8.0, 8.5, 7.5, 8.2],
    ]);
    assert.equal(t.exitPrice, 8.0);
    near(t.returnPct, -20);
  });

  it("a gap through the target fills at the open, not the target price", () => {
    const [t] = run([
      [10, 10.2, 9.9, 10],
      [12, 12.5, 11.5, 12.2],
    ]);
    assert.equal(t.exitReason, "take-profit");
    assert.equal(t.exitPrice, 12);
  });

  it("with no stop or target set, neither ever triggers", () => {
    const [t] = run([[10, 50, 0.5, 10]], null, null);
    assert.equal(t.exitReason, "end-of-data");
  });

  describe("one candle reaching both levels", () => {
    // Opens at 10 (between 9 and 11), spans 8-12. Close 11 = green, close 9 = red.
    const green: [number, number, number, number] = [10, 12, 8, 11];
    const red: [number, number, number, number] = [10, 12, 8, 9];

    it("stop-first picks the stop", () => {
      const [t] = run([green], 10, 10, "stop-first");
      assert.deepEqual([t.exitReason, t.exitPrice, t.ambiguous], ["stop-loss", 9, true]);
    });
    it("target-first picks the target", () => {
      const [t] = run([green], 10, 10, "target-first");
      assert.deepEqual([t.exitReason, t.exitPrice, t.ambiguous], ["take-profit", 11, true]);
    });
    it("by-candle-colour: green assumes the dip came first, red the rally", () => {
      assert.equal(run([green], 10, 10, "by-candle-colour")[0].exitReason, "stop-loss");
      assert.equal(run([red], 10, 10, "by-candle-colour")[0].exitReason, "take-profit");
    });
    it("is not flagged ambiguous when only one level is touched", () => {
      assert.equal(run([[10, 10.2, 8.5, 9.5]])[0].ambiguous, false);
    });
    it("a gap that opens past a level settles the order regardless of the rule", () => {
      // Opens at 8.5 (already through the stop at 9) and rallies through 11 later in the bar.
      const gap: [number, number, number, number] = [10, 10.2, 9.9, 10];
      const [t] = run([gap, [8.5, 12, 8.0, 11.5]], 10, 10, "target-first");
      assert.equal(t.exitReason, "stop-loss");
      assert.equal(t.exitPrice, 8.5);
      assert.equal(t.ambiguous, false);
    });
  });
});

describe("stopHitFirst: same-candle order depends on trade direction", () => {
  const green = { open: 10, close: 11 }; // read as open -> low -> high -> close
  const red = { open: 10, close: 9 }; // read as open -> high -> low -> close
  const doji = { open: 10, close: 10 };

  it("long: the low is the stop, so a green candle hits the stop first and a red one the target", () => {
    assert.equal(stopHitFirst("by-candle-colour", "long", green), true);
    assert.equal(stopHitFirst("by-candle-colour", "long", red), false);
  });

  it("short: the low is the target, so a green candle hits the target first and a red one the stop", () => {
    assert.equal(stopHitFirst("by-candle-colour", "short", green), false);
    assert.equal(stopHitFirst("by-candle-colour", "short", red), true);
  });

  it("the colour rule is exactly mirrored between long and short for every candle", () => {
    for (const candle of [green, red, doji]) {
      assert.notEqual(
        stopHitFirst("by-candle-colour", "long", candle),
        stopHitFirst("by-candle-colour", "short", candle),
      );
    }
  });

  it("a doji counts as green, consistently for both directions", () => {
    assert.equal(stopHitFirst("by-candle-colour", "long", doji), true);
    assert.equal(stopHitFirst("by-candle-colour", "short", doji), false);
  });

  it("stop-first and target-first ignore both colour and direction", () => {
    for (const direction of ["long", "short"] as const) {
      for (const candle of [green, red]) {
        assert.equal(stopHitFirst("stop-first", direction, candle), true);
        assert.equal(stopHitFirst("target-first", direction, candle), false);
      }
    }
  });
});

describe("equity curve", () => {
  const r = runBacktest(TIMING, cfg(MA_1_2));
  const eq = r.equity.map((p) => p.value);

  it("has one point per candle with matching dates", () => {
    assert.equal(r.equity.length, TIMING.length);
    assert.deepEqual(r.equity.map((p) => p.date), TIMING.map((c) => c.date));
  });

  it("is flat at the starting capital until the fill, including on the signal bar", () => {
    assert.deepEqual(eq.slice(0, 4), [10000, 10000, 10000, 10000]);
  });

  it("marks to each close while in the trade, then locks in the exit fill", () => {
    near(eq[4], (10000 * 10) / 9.6); // entered 9.6, close 10
    near(eq[5], (10000 * 11) / 9.6); // close 11
    near(eq[6], (10000 * 10) / 9.6); // close 10
    near(eq[7], (10000 * 9.4) / 9.6); // exited at bar 7's open, 9.4, not its close
  });

  it("max drawdown is the peak-to-trough of that curve", () => {
    // peak 11/9.6, trough 9.4/9.6 -> (11 - 9.4) / 11
    near(r.stats.maxDrawdownPct, (1.6 / 11) * 100);
  });

  it("net return equals the final equity change and the compounded trade returns", () => {
    near(r.stats.finalEquity, (10000 * 9.4) / 9.6);
    near(r.stats.netReturnPct, (9.4 / 9.6 - 1) * 100);
    near(r.stats.netProfit, (10000 * 9.4) / 9.6 - 10000);
  });

  it("buy and hold runs from the first open to the last close", () => {
    near(r.stats.buyAndHoldPct, (9 / 10 - 1) * 100); // first open 10, last close 9
  });
});

describe("computeStats on hand-made trades", () => {
  const trade = (returnPct: number): Trade => ({
    entryIndex: 0,
    exitIndex: 1,
    entryDate: date(0),
    exitDate: date(1),
    entryPrice: 100,
    exitPrice: 100 * (1 + returnPct / 100),
    returnPct,
    exitReason: "signal",
    ambiguous: false,
  });
  const point = (i: number, value: number) => ({ date: date(i), value });

  it("profit factor, R:R, win rate and net return from +10, -5, +20, -10", () => {
    // equity: 10000 -> 11000 -> 10450 -> 12540 -> 11286
    const equity = [10000, 11000, 10450, 12540, 11286].map((v, i) => point(i, v));
    const s = computeStats([trade(10), trade(-5), trade(20), trade(-10)], equity, equity);
    assert.equal(s.trades, 4);
    assert.equal(s.winRatePct, 50);
    near(s.profitFactor, 30 / 15); // (10+20) / (5+10)
    near(s.avgWinPct, 15);
    near(s.avgLossPct, 7.5);
    near(s.avgRewardRisk, 2); // 15 / 7.5
    near(s.netReturnPct, 12.86); // 1.1 * 0.95 * 1.2 * 0.9 - 1
    near(s.maxDrawdownPct, 10); // 12540 -> 11286
  });

  it("no losing trade: profit factor is Infinity and R:R is undefined", () => {
    const equity = [10000, 11000].map((v, i) => point(i, v));
    const s = computeStats([trade(10)], equity, equity);
    assert.equal(s.profitFactor, Infinity);
    assert.equal(s.avgRewardRisk, null);
  });

  it("only losing trades: profit factor 0, R:R undefined", () => {
    const equity = [10000, 9500].map((v, i) => point(i, v));
    const s = computeStats([trade(-5)], equity, equity);
    assert.equal(s.profitFactor, 0);
    assert.equal(s.avgRewardRisk, null);
  });

  it("a break-even trade counts as neither a win nor a loss", () => {
    const equity = [10000, 10000].map((v, i) => point(i, v));
    const s = computeStats([trade(0)], equity, equity);
    assert.equal(s.winRatePct, 0);
    assert.equal(s.profitFactor, null);
  });

  it("no trades gives zeros and nulls, not NaN", () => {
    const flat = [point(0, 10000), point(1, 10000)];
    const s = computeStats([], flat, flat);
    assert.equal(s.trades, 0);
    assert.equal(s.winRatePct, 0);
    assert.equal(s.profitFactor, null);
    assert.equal(s.netReturnPct, 0);
    assert.equal(s.maxDrawdownPct, 0);
  });
});

describe("degenerate input", () => {
  it("empty and single-candle data do not crash or trade", () => {
    for (const data of [[], fromOC([10], [10])]) {
      const r = runBacktest(data, cfg(MA_1_2));
      assert.equal(r.trades.length, 0);
      assert.equal(r.stats.finalEquity, INITIAL_CAPITAL);
    }
  });
});

describe("validateConfig", () => {
  it("rejects fast >= slow, accepts fast < slow", () => {
    assert.ok(validateConfig(cfg({ type: "ma-cross", fast: 10, slow: 10 })));
    assert.ok(validateConfig(cfg({ type: "ma-cross", fast: 30, slow: 10 })));
    assert.equal(validateConfig(cfg({ type: "ma-cross", fast: 9, slow: 10 })), null);
  });
  it("rejects non-integer, zero and negative periods", () => {
    assert.ok(validateConfig(cfg({ type: "ma-cross", fast: 0, slow: 5 })));
    assert.ok(validateConfig(cfg({ type: "ma-cross", fast: 1.5, slow: 5 })));
    assert.ok(validateConfig(cfg({ type: "rsi", period: 1, oversold: 30, overbought: 70 })));
  });
  it("requires oversold < overbought within 0-100", () => {
    assert.ok(validateConfig(cfg({ type: "rsi", period: 14, oversold: 70, overbought: 30 })));
    assert.ok(validateConfig(cfg({ type: "rsi", period: 14, oversold: 30, overbought: 101 })));
    assert.equal(validateConfig(cfg({ type: "rsi", period: 14, oversold: 30, overbought: 70 })), null);
  });
  it("stop and target must be positive when set; stop must be under 100%", () => {
    assert.ok(validateConfig(cfg(MA_1_2, 0)));
    assert.ok(validateConfig(cfg(MA_1_2, null, -1)));
    assert.ok(validateConfig(cfg(MA_1_2, 100)));
    assert.equal(validateConfig(cfg(MA_1_2, 5, 10)), null);
  });
});

// ---------------------------------------------------------------------------------------------
// Property test: knowing the future must not change the past. Cutting the data short, or
// rewriting everything after a bar, must leave all earlier decisions untouched.
// ---------------------------------------------------------------------------------------------
describe("no look-ahead: the past is independent of the future", () => {
  const walk = (() => {
    let seed = 42;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    let p = 100;
    return Array.from({ length: 320 }, (): Candle => {
      const open = p;
      const close = open + (rnd() - 0.5) * 4;
      p = close;
      return {
        date: "",
        open,
        close,
        high: Math.max(open, close) + rnd(),
        low: Math.min(open, close) - rnd(),
        volume: 1,
      };
    }).map((c, i) => ({ ...c, date: date(i) }));
  })();

  const configs: [string, BacktestConfig][] = [
    ["MA 3/8, stop 3%, target 5%", cfg({ type: "ma-cross", fast: 3, slow: 8 }, 3, 5)],
    ["MA 5/20, no stop or target", cfg({ type: "ma-cross", fast: 5, slow: 20 })],
    ["RSI 5 25/70, stop 4%", cfg({ type: "rsi", period: 5, oversold: 25, overbought: 70 }, 4, null)],
  ];

  for (const [name, config] of configs) {
    const full = runBacktest(walk, config);

    it(`${name}: is not vacuous (it actually trades)`, () => {
      assert.ok(full.trades.length >= 3, `only ${full.trades.length} trades`);
    });

    for (const cut of [60, 133, 250]) {
      it(`${name}: truncating at bar ${cut} changes no earlier decision`, () => {
        const part = runBacktest(walk.slice(0, cut), config);
        // Everything except the forced end-of-data close must match the full run exactly.
        const settled = part.trades.filter((t) => t.exitReason !== "end-of-data");
        assert.deepEqual(settled, full.trades.slice(0, settled.length));
        // The forced close is the same trade, entered at the same bar and price.
        const forced = part.trades.find((t) => t.exitReason === "end-of-data");
        if (forced) {
          assert.equal(forced.entryIndex, full.trades[settled.length].entryIndex);
          assert.equal(forced.entryPrice, full.trades[settled.length].entryPrice);
        }
        assert.deepEqual(part.equity, full.equity.slice(0, cut));
      });

      it(`${name}: rewriting every bar after ${cut} changes no earlier decision`, () => {
        const tampered = walk.map((c, i) =>
          i < cut ? c : { ...c, open: c.open * 2, high: c.high * 2.5, low: c.low * 0.4, close: c.close * 1.7 },
        );
        const alt = runBacktest(tampered, config);
        assert.deepEqual(alt.equity.slice(0, cut), full.equity.slice(0, cut));
        assert.deepEqual(
          alt.trades.filter((t) => t.exitIndex < cut),
          full.trades.filter((t) => t.exitIndex < cut),
        );
      });
    }
  }
});
