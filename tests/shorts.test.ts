import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  INITIAL_CAPITAL,
  runBacktest,
  type BacktestConfig,
  type SameCandleRule,
  type Strategy,
  type TradeMode,
} from "@/lib/backtest";
import { rsi } from "@/lib/indicators";
import type { Candle } from "@/lib/parseCandles";
import { MA_1_2, bars, cfg, date, fromOC, near } from "./helpers";

// ---------------------------------------------------------------------------------------------
// Crossover, hand-calculated. fast = close, slow = 2-bar mean.
//
//   i      0    1     2     3     4     5    6    7    8
//   close  10   11    12    11    10    9    8    9    10
//   open   10   10.5  11.5  12    10.8  9.5  8.8  8.2  8.64
//   slow   -    10.5  11.5  11.5  10.5  9.5  8.5  8.5  9.5
//
// Cross DOWN at i=3 (fast 12 >= 11.5, then 11 < 11.5): a short enters at bar 4's open, 10.8.
// Cross UP   at i=7 (fast 8 <= 8.5, then 9 > 8.5): the short covers at bar 8's open, 8.64.
// Short return = (10.8 - 8.64) / 10.8 = +20%.
// ---------------------------------------------------------------------------------------------
const MA_DATA = fromOC(
  [10, 10.5, 11.5, 12, 10.8, 9.5, 8.8, 8.2, 8.64],
  [10, 11, 12, 11, 10, 9, 8, 9, 10],
);
const run = (data: Candle[], mode: TradeMode, strategy: Strategy = MA_1_2) =>
  runBacktest(data, cfg(strategy, null, null, "stop-first", mode));

describe("short signals: the inverse of the long rules (crossover)", () => {
  const r = run(MA_DATA, "short");

  it("sells short on the cross DOWN, filled at the next candle's open", () => {
    assert.equal(r.trades.length, 1);
    const t = r.trades[0];
    assert.equal(t.direction, "short");
    assert.equal(t.entryIndex, 4, "signal on bar 3, fill on bar 4");
    assert.equal(t.entryPrice, 10.8, "bar 4 open");
    assert.notEqual(t.entryPrice, MA_DATA[3].close, "not the signal bar's close");
  });

  it("covers on the cross UP, filled at the next candle's open", () => {
    const t = r.trades[0];
    assert.equal(t.exitIndex, 8, "signal on bar 7, fill on bar 8");
    assert.equal(t.exitPrice, 8.64);
    assert.equal(t.exitReason, "signal");
  });

  it("a short profits when the price falls: (entry - exit) / entry", () => {
    near(r.trades[0].returnPct, 20);
  });

  it("the cross up that covers the short is a long entry, not a short entry", () => {
    const long = run(MA_DATA, "long");
    assert.equal(long.trades.length, 1);
    assert.equal(long.trades[0].direction, "long");
    assert.equal(long.trades[0].entryIndex, 8);
    assert.equal(long.trades[0].entryPrice, 8.64);
    near(long.trades[0].returnPct, (10 / 8.64 - 1) * 100); // closed at the last close, 10
  });

  it("a short signal on the very last candle never trades", () => {
    assert.equal(run(MA_DATA.slice(0, 4), "short").trades.length, 0); // cross down is on bar 3, the last
  });

  it("a short still open at the end is closed at the final close", () => {
    const t = run(MA_DATA.slice(0, 7), "short").trades[0]; // no cover signal yet
    assert.equal(t.exitReason, "end-of-data");
    assert.equal(t.exitIndex, 6);
    assert.equal(t.exitPrice, 8);
    near(t.returnPct, ((10.8 - 8) / 10.8) * 100);
  });
});

describe("short equity: marked to market with the inverted payoff", () => {
  const r = run(MA_DATA, "short");
  const eq = r.equity.map((p) => p.value);
  const short = (close: number) => 10000 * (2 - close / 10.8); // worth of $10,000 short from 10.8

  it("is flat until the fill, including on the signal bar", () => {
    assert.deepEqual(eq.slice(0, 4), [10000, 10000, 10000, 10000]);
  });

  it("rises as the price falls and drops as it rises", () => {
    near(eq[4], short(10)); // 10740.74
    near(eq[5], short(9)); // 11666.67
    near(eq[6], short(8)); // 12592.59
    near(eq[7], short(9)); // price bounced: 11666.67
  });

  it("locks in the cover fill, not that candle's close, then stays flat", () => {
    near(eq[8], 12000); // 10000 * 1.2 from the 8.64 cover; bar 8 closes at 10
  });

  it("max drawdown comes from the short's own curve", () => {
    // peak at bar 6 (12592.59), trough at bar 7 (11666.67)
    near(r.stats.maxDrawdownPct, ((short(8) - short(9)) / short(8)) * 100);
  });

  it("net return matches the trade", () => {
    near(r.stats.netReturnPct, 20);
    near(r.stats.finalEquity, 12000);
  });
});

describe("both: stop-and-reverse", () => {
  const r = run(MA_DATA, "both");

  it("short on the cross down, then reverses to long at the SAME open on the cross up", () => {
    assert.equal(r.trades.length, 2);
    const [s, l] = r.trades;
    assert.deepEqual([s.direction, s.entryIndex, s.exitIndex, s.entryPrice, s.exitPrice], ["short", 4, 8, 10.8, 8.64]);
    assert.deepEqual([l.direction, l.entryIndex, l.entryPrice], ["long", 8, 8.64]);
    assert.equal(l.entryIndex, s.exitIndex);
    assert.equal(l.entryPrice, s.exitPrice, "reversal happens at one price");
  });

  it("equity: the cover is locked in, then the new long is marked to the close", () => {
    near(r.equity[8].value, (12000 * 10) / 8.64); // long from 8.64, bar 8 closes at 10
    near(r.stats.finalEquity, (12000 * 10) / 8.64);
  });

  it("long-only and short-only never open the other side", () => {
    assert.ok(run(MA_DATA, "long").trades.every((t) => t.direction === "long"));
    assert.ok(run(MA_DATA, "short").trades.every((t) => t.direction === "short"));
  });
});

// ---------------------------------------------------------------------------------------------
// RSI(2), oversold 30, overbought 70, hand-calculated:
//   close  10  11  12   11   10   9     10    12     12     10     10
//   RSI    -   -   100  50   25   12.5  56.25 85.42  85.42  23.30  23.30
// Short entry: RSI rises THROUGH 70 (56.25 -> 85.42 at i=7); not again while it stays above.
// Short exit:  RSI at or below 30 (first time after entry: i=9).
// ---------------------------------------------------------------------------------------------
const RSI: Strategy = { type: "rsi", period: 2, oversold: 30, overbought: 70 };
const RSI_DATA = fromOC(
  [10, 10.5, 11.5, 11.5, 10.5, 9.5, 9.2, 10.5, 12.5, 11, 10],
  [10, 11, 12, 11, 10, 9, 10, 12, 12, 10, 10],
);

describe("short signals: the inverse of the long rules (RSI)", () => {
  it("the hand-calculated RSI values are what the signals are built on", () => {
    const v = rsi(RSI_DATA.map((c) => c.close), 2);
    near(v[2], 100);
    near(v[3], 50);
    near(v[4], 25);
    near(v[5], 12.5);
    near(v[6], 56.25);
    near(v[7], 85.4166666667); // 100 * 1.28125 / (1.28125 + 0.21875)
    near(v[9], 23.2954545);
  });

  it("shorts the bar after RSI crosses up through overbought, covers the bar after it falls to oversold", () => {
    const r = run(RSI_DATA, "short", RSI);
    assert.equal(r.trades.length, 1);
    const t = r.trades[0];
    assert.deepEqual([t.direction, t.entryIndex, t.entryPrice], ["short", 8, 12.5]); // signal i=7
    assert.deepEqual([t.exitIndex, t.exitPrice, t.exitReason], [10, 10, "signal"]); // signal i=9
    near(t.returnPct, 20);
  });

  it("does not short just because RSI sits above overbought (needs a fresh cross)", () => {
    const rising = fromOC([1, 2, 3, 4, 5, 6, 7, 8], [2, 3, 4, 5, 6, 7, 8, 9]); // RSI 100 from its first value
    assert.equal(run(rising, "short", RSI).trades.length, 0);
  });

  it("does not cover on an oversold reading while flat", () => {
    // RSI is already <= 30 at i=4, long before any short exists.
    assert.equal(run(RSI_DATA.slice(0, 7), "short", RSI).trades.length, 0);
  });

  it("long-only on the same data is unchanged by the short rules", () => {
    const r = run(RSI_DATA, "long", RSI);
    assert.deepEqual(
      r.trades.map((t) => [t.direction, t.entryIndex, t.exitIndex]),
      [
        ["long", 5, 8],
        ["long", 10, 10],
      ],
    );
  });

  it("both: each RSI exit also opens the other side at the same open", () => {
    const r = run(RSI_DATA, "both", RSI);
    assert.deepEqual(
      r.trades.map((t) => [t.direction, t.entryIndex, t.exitIndex, t.entryPrice, t.exitPrice]),
      [
        ["long", 5, 8, 9.5, 12.5], // buys the dip, sells into overbought
        ["short", 8, 10, 12.5, 10], // reverses at that same 12.5 open; covers at the next oversold
        ["long", 10, 10, 10, 10], // reverses again at 10; closed at the final close, 10
      ],
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Short stops and targets. A MA(1,2) cross DOWN at i=3 fills a short on bar 4 at its open, 10.
// With 10% levels the stop is ABOVE at 11 and the target BELOW at 9.
// ---------------------------------------------------------------------------------------------
describe("short stop loss and take profit (inverted levels)", () => {
  const setup: [number, number, number, number][] = [
    [10, 10.5, 9.5, 10],
    [10, 11.5, 9.8, 11],
    [11, 12.5, 10.8, 12],
    [12, 12.3, 10.8, 11], // fast crosses below slow here
  ];
  const go = (
    next: [number, number, number, number][],
    sl: number | null = 10,
    tp: number | null = 10,
    rule: SameCandleRule = "stop-first",
  ) => runBacktest(bars([...setup, ...next]), cfg(MA_1_2, sl, tp, rule, "short")).trades;

  it("opens a short at bar 4's open and sets the stop above and target below it", () => {
    const [t] = go([[10, 10.4, 9.6, 10]]);
    assert.deepEqual([t.direction, t.entryIndex, t.entryPrice], ["short", 4, 10]);
  });

  it("levels come from the entry fill, not the signal bar's close", () => {
    // Stop is 11 (10% over 10). Built from the signal close of 11 it would be 12.1 and this 11.05 high would not stop us.
    const [t] = go([[10, 11.05, 9.5, 10.5]]);
    assert.deepEqual([t.exitReason, t.exitPrice], ["stop-loss", 11]);
    near(t.returnPct, -10); // (10 - 11) / 10
  });

  it("a high exactly at the stop triggers it (>=), a high one tick below does not", () => {
    assert.equal(go([[10, 11, 9.5, 10.5]])[0].exitReason, "stop-loss");
    assert.equal(go([[10, 10.99, 9.5, 10.5]])[0].exitReason, "end-of-data");
  });

  it("a low exactly at the target triggers it (<=), a low one tick above does not", () => {
    const [hit] = go([[10, 10.5, 9, 9.5]]);
    assert.deepEqual([hit.exitReason, hit.exitPrice], ["take-profit", 9]);
    near(hit.returnPct, 10); // (10 - 9) / 10
    assert.equal(go([[10, 10.5, 9.01, 9.5]])[0].exitReason, "end-of-data");
  });

  it("a rising high does not hit the target and a falling low does not hit the stop", () => {
    // Long logic would call these the target (high >= 11) and the stop (low <= 9). For a short they are the reverse.
    assert.equal(go([[10, 11.05, 9.5, 10.5]], 10, null)[0].exitReason, "stop-loss");
    assert.equal(go([[10, 10.5, 8.9, 9.5]], null, 10)[0].exitReason, "take-profit");
  });

  it("is checked on the entry candle itself", () => {
    const [t] = go([[10, 11.2, 9.6, 10.4]]);
    assert.deepEqual([t.entryIndex, t.exitIndex, t.exitPrice], [4, 4, 11]);
  });

  it("is checked on later candles too", () => {
    const [t] = go([
      [10, 10.3, 9.8, 10.1],
      [10.1, 11.5, 10, 11.2],
    ]);
    assert.deepEqual([t.exitIndex, t.exitReason, t.exitPrice], [5, "stop-loss", 11]);
  });

  it("a gap UP through the stop fills at the open (worse than the stop)", () => {
    const [t] = go([
      [10, 10.2, 9.9, 10],
      [12, 12.5, 11.5, 12.2],
    ]);
    assert.deepEqual([t.exitReason, t.exitPrice], ["stop-loss", 12]);
    near(t.returnPct, -20);
  });

  it("a gap DOWN through the target fills at the open (better than the target)", () => {
    const [t] = go([
      [10, 10.2, 9.9, 10],
      [8, 8.5, 7.5, 8.2],
    ]);
    assert.deepEqual([t.exitReason, t.exitPrice], ["take-profit", 8]);
    near(t.returnPct, 20);
  });

  it("with no stop or target set, a short with a moderate range just runs on", () => {
    const [t] = go([[10, 15, 5, 10]], null, null);
    assert.equal(t.exitReason, "end-of-data");
  });

  describe("one candle reaching both levels", () => {
    const green: [number, number, number, number] = [10, 12, 8, 10.5]; // reads as open -> low -> high -> close
    const red: [number, number, number, number] = [10, 12, 8, 9.5]; // reads as open -> high -> low -> close

    it("stop-first picks the stop (above)", () => {
      const [t] = go([green], 10, 10, "stop-first");
      assert.deepEqual([t.exitReason, t.exitPrice, t.ambiguous], ["stop-loss", 11, true]);
    });
    it("target-first picks the target (below)", () => {
      const [t] = go([green], 10, 10, "target-first");
      assert.deepEqual([t.exitReason, t.exitPrice, t.ambiguous], ["take-profit", 9, true]);
    });
    it("by-candle-colour for a short: green reaches the low (target) first, red the high (stop) first", () => {
      assert.equal(go([green], 10, 10, "by-candle-colour")[0].exitReason, "take-profit");
      assert.equal(go([red], 10, 10, "by-candle-colour")[0].exitReason, "stop-loss");
    });
    it("by-candle-colour gives the opposite answer for a long on the same candle", () => {
      const long = runBacktest(
        bars([
          [10, 10.5, 9.5, 10],
          [9, 9.5, 8.5, 9],
          [8, 8.5, 7.5, 8],
          [9, 9.5, 8.5, 9],
          green,
        ]),
        cfg(MA_1_2, 10, 10, "by-candle-colour", "long"),
      ).trades[0];
      assert.equal(long.exitReason, "stop-loss"); // a long's low is its stop
    });
    it("a gap through the target settles the order whatever the rule says", () => {
      // Opens at 8.5, already below the 9 target, then spikes through the 11 stop later in the bar.
      const [t] = go(
        [
          [10, 10.2, 9.9, 10],
          [8.5, 11.5, 8, 10],
        ],
        10,
        10,
        "stop-first",
      );
      assert.deepEqual([t.exitReason, t.exitPrice, t.ambiguous], ["take-profit", 8.5, false]);
    });
    it("a gap through the stop settles the order whatever the rule says", () => {
      // Opens at 11.5, already above the 11 stop, then falls through the 9 target later in the bar.
      const [t] = go(
        [
          [10, 10.2, 9.9, 10],
          [11.5, 11.8, 8.5, 9],
        ],
        10,
        10,
        "target-first",
      );
      assert.deepEqual([t.exitReason, t.exitPrice, t.ambiguous], ["stop-loss", 11.5, false]);
    });
  });

  describe("a short can lose more than it risked, so it is liquidated at +100%", () => {
    it("with no stop, a price that doubles ends the trade at the doubled price", () => {
      const [t] = go(
        [
          [10, 20, 9.5, 15],
          [15, 16, 5, 6],
        ],
        null,
        null,
      );
      assert.deepEqual([t.exitIndex, t.exitReason, t.exitPrice], [4, "liquidated", 20]);
      near(t.returnPct, -100);
    });

    it("a gap beyond the doubled price still only loses the account, never more", () => {
      const [t] = go(
        [
          [10, 10.2, 9.9, 10],
          [25, 26, 24, 25.5],
        ],
        null,
        null,
      );
      assert.deepEqual([t.exitReason, t.exitPrice], ["liquidated", 25]);
      assert.equal(t.returnPct, -100, "capped, not -150");
    });

    it("the capped loss also applies to a stopped-out gap", () => {
      const [t] = go(
        [
          [10, 10.2, 9.9, 10],
          [25, 26, 24, 25.5],
        ],
        10,
        null,
      );
      assert.deepEqual([t.exitReason, t.exitPrice], ["stop-loss", 25]);
      assert.equal(t.returnPct, -100);
    });

    it("equity goes to zero and stays there, never negative", () => {
      const r = runBacktest(
        bars([
          ...setup,
          [10, 20, 9.5, 15],
          [15, 16, 5, 6],
          [6, 7, 4, 5],
        ]),
        cfg(MA_1_2, null, null, "stop-first", "short"),
      );
      assert.deepEqual(r.equity.slice(4).map((p) => p.value), [0, 0, 0]);
      assert.ok(r.equity.every((p) => p.value >= 0));
      assert.equal(r.stats.netReturnPct, -100);
    });

    it("liquidation acts as the stop for the same-candle rule when only a target is set", () => {
      const both: [number, number, number, number] = [10, 20.5, 8, 12]; // reaches 20 (liquidation) and 9 (target)
      assert.deepEqual(
        [
          go([both], null, 10, "stop-first")[0].exitReason,
          go([both], null, 10, "target-first")[0].exitReason,
        ],
        ["liquidated", "take-profit"],
      );
    });

    it("a long with no stop is never liquidated, however far the price falls", () => {
      const r = runBacktest(
        bars([
          [10, 10.5, 9.5, 10],
          [9, 9.5, 8.5, 9],
          [8, 8.5, 7.5, 8],
          [9, 9.5, 8.5, 9],
          [9, 9.5, 0.5, 1],
        ]),
        cfg(MA_1_2, null, null, "stop-first", "long"),
      );
      assert.equal(r.trades[0].exitReason, "end-of-data");
      assert.ok(r.stats.finalEquity > 0);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Invariants over 320 random candles, for the long, short and both modes.
// ---------------------------------------------------------------------------------------------
describe("short and both modes over random data", () => {
  const walk = (() => {
    let seed = 42;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    let p = 100;
    return Array.from({ length: 320 }, (_, i): Candle => {
      const open = p;
      const close = open + (rnd() - 0.5) * 4;
      p = close;
      return {
        date: date(i),
        open,
        close,
        high: Math.max(open, close) + rnd(),
        low: Math.min(open, close) - rnd(),
        volume: 1,
      };
    });
  })();

  const configs: [string, BacktestConfig][] = [
    ["short MA 3/8, stop 3%, target 5%", cfg({ type: "ma-cross", fast: 3, slow: 8 }, 3, 5, "stop-first", "short")],
    ["short MA 5/20, no stop or target", cfg({ type: "ma-cross", fast: 5, slow: 20 }, null, null, "stop-first", "short")],
    ["short RSI 5 25/70, stop 4%", cfg({ type: "rsi", period: 5, oversold: 25, overbought: 70 }, 4, null, "stop-first", "short")],
    ["both MA 3/8, stop 3%, target 5%, by colour", cfg({ type: "ma-cross", fast: 3, slow: 8 }, 3, 5, "by-candle-colour", "both")],
    ["both MA 5/20, no stop or target", cfg({ type: "ma-cross", fast: 5, slow: 20 }, null, null, "stop-first", "both")],
    ["both RSI 5 25/70, stop 4%, target 6%", cfg({ type: "rsi", period: 5, oversold: 25, overbought: 70 }, 4, 6, "target-first", "both")],
  ];

  for (const [name, config] of configs) {
    const full = runBacktest(walk, config);

    it(`${name}: trades the intended side(s) and is not vacuous`, () => {
      assert.ok(full.trades.length >= 3, `only ${full.trades.length} trades`);
      const sides = new Set(full.trades.map((t) => t.direction));
      if (config.mode === "both") assert.deepEqual([...sides].sort(), ["long", "short"]);
      else assert.deepEqual([...sides], [config.mode]);
    });

    it(`${name}: positions never overlap`, () => {
      for (let k = 1; k < full.trades.length; k++) {
        assert.ok(full.trades[k].entryIndex >= full.trades[k - 1].exitIndex, `trade ${k} overlaps`);
      }
    });

    it(`${name}: every return follows from its own fills and direction`, () => {
      for (const t of full.trades) {
        const raw = (t.direction === "long" ? 1 : -1) * (t.exitPrice / t.entryPrice - 1) * 100;
        near(t.returnPct, Math.max(-100, raw), 1e-9);
      }
    });

    it(`${name}: marked-to-market equity ends exactly where the compounded trades say`, () => {
      const compounded = full.trades.reduce((a, t) => a * (1 + t.returnPct / 100), INITIAL_CAPITAL);
      near(full.stats.finalEquity, compounded, 1e-6);
      assert.ok(full.equity.every((p) => p.value >= 0));
    });

    for (const cut of [60, 133, 250]) {
      it(`${name}: truncating at bar ${cut} changes no earlier decision`, () => {
        const part = runBacktest(walk.slice(0, cut), config);
        const settled = part.trades.filter((t) => t.exitReason !== "end-of-data");
        assert.deepEqual(settled, full.trades.slice(0, settled.length));
        const forced = part.trades.find((t) => t.exitReason === "end-of-data");
        if (forced) {
          const same = full.trades[settled.length];
          assert.deepEqual([forced.direction, forced.entryIndex, forced.entryPrice], [same.direction, same.entryIndex, same.entryPrice]);
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
