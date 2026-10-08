import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  INITIAL_CAPITAL,
  parseCost,
  runBacktest,
  validateConfig,
  type BacktestConfig,
  type Costs,
  type Strategy,
  type TradeMode,
} from "@/lib/backtest";
import type { Candle } from "@/lib/parseCandles";
import { LONG_DATA, MA_1_2, SHORT_DATA, bars, cfg, fromOC, near, randomWalk } from "./helpers";

const withCosts = (data: Candle[], mode: TradeMode, costs: Partial<Costs>, strategy: Strategy = MA_1_2) =>
  runBacktest(data, cfg(strategy, null, null, "stop-first", mode, costs));

// ---------------------------------------------------------------------------------------------
// Every fill moves the price against the trade by x = spread/2 + slippage:
//   buys  (long entry, short cover):  market * (1 + x)
//   sells (long exit,  short entry):  market * (1 - x)
// Commission comes out of the account at each fill. Account value afterwards:
//   long : (before - commission) * Fout / Fin - commission
//   short: (before - commission) * (2 - Fout / Fin) - commission
// ---------------------------------------------------------------------------------------------
describe("costs on a long: market 9.6 in, 9.4 out", () => {
  const free = withCosts(LONG_DATA, "long", {});

  it("with no costs the fills are the market prices and the costs are exactly zero", () => {
    const [t] = free.trades;
    assert.deepEqual([t.entryPrice, t.exitPrice, t.marketEntryPrice, t.marketExitPrice], [9.6, 9.4, 9.6, 9.4]);
    assert.equal(t.costs, 0);
    assert.equal(free.stats.totalCosts, 0);
  });

  it("slippage 1%: buys 1% higher (9.696), sells 1% lower (9.306)", () => {
    // 10000 * 9.306 / 9.696 = 9597.77 -> -4.02228%; the free trade ends at 10000 * 9.4 / 9.6 = 9791.67
    const r = withCosts(LONG_DATA, "long", { slippagePct: 1 });
    const [t] = r.trades;
    near(t.entryPrice, 9.696, 1e-9);
    near(t.exitPrice, 9.306, 1e-9);
    assert.deepEqual([t.marketEntryPrice, t.marketExitPrice], [9.6, 9.4], "market prices are kept");
    near(t.returnPct, -4.02228, 1e-4);
    near(t.pnl, 9597.7723 - 10000, 1e-3);
    near(t.costs, 193.8944, 1e-3);
  });

  it("spread 2% costs the same as slippage 1% (half the spread each way)", () => {
    const spread = withCosts(LONG_DATA, "long", { spreadPct: 2 });
    const slip = withCosts(LONG_DATA, "long", { slippagePct: 1 });
    near(spread.trades[0].entryPrice, slip.trades[0].entryPrice, 1e-12);
    near(spread.trades[0].exitPrice, slip.trades[0].exitPrice, 1e-12);
    near(spread.stats.finalEquity, slip.stats.finalEquity, 1e-9);
  });

  it("commission $10 is paid on entry and again on exit", () => {
    // capital 10000 - 10 = 9990; 9990 * 9.4 / 9.6 = 9781.875; minus 10 on exit = 9771.875
    const [t] = withCosts(LONG_DATA, "long", { commission: 10 }).trades;
    assert.deepEqual([t.entryPrice, t.exitPrice], [9.6, 9.4], "commission does not move the price");
    near(t.returnPct, -2.28125, 1e-9);
    near(t.pnl, 9771.875 - 10000, 1e-9);
    near(t.costs, 19.7917, 1e-3); // 9791.67 - 9771.875: $20 of fees plus the profit they stopped compounding
  });

  it("all three together: x = 0.2% + 0.3% = 0.5%, commission $20", () => {
    // Fin 9.648, Fout 9.353, capital 9980: 9980 * 9.353 / 9.648 - 20 = 9654.85
    const r = withCosts(LONG_DATA, "long", { spreadPct: 0.4, slippagePct: 0.3, commission: 20 });
    const [t] = r.trades;
    near(t.entryPrice, 9.648, 1e-9);
    near(t.exitPrice, 9.353, 1e-9);
    near(t.returnPct, -3.45151, 1e-4);
    near(t.costs, 136.818, 1e-3);
    near(r.stats.finalEquity, 9654.8487, 1e-3);
  });

  it("every cost makes the trade worse and none makes it better", () => {
    const base = free.trades[0].returnPct;
    for (const c of [{ spreadPct: 0.5 }, { slippagePct: 0.5 }, { commission: 5 }]) {
      const t = withCosts(LONG_DATA, "long", c).trades[0];
      assert.ok(t.returnPct < base, JSON.stringify(c));
      assert.ok(t.costs > 0, JSON.stringify(c));
    }
    const t = withCosts(LONG_DATA, "long", { spreadPct: 1 }).trades[0];
    assert.ok(t.entryPrice > t.marketEntryPrice, "a buy pays above the market");
    assert.ok(t.exitPrice < t.marketExitPrice, "a sell receives below the market");
  });

  it("equity: flat until the fill, then marked to the market close with entry costs already paid", () => {
    const r = withCosts(LONG_DATA, "long", { commission: 10 });
    const eq = r.equity.map((p) => p.value);
    assert.deepEqual(eq.slice(0, 4), [10000, 10000, 10000, 10000]);
    near(eq[4], (9990 * 10) / 9.6); // 10406.25: capital 9990, close 10, no exit cost yet
    near(eq[5], (9990 * 11) / 9.6);
    near(eq[7], 9771.875); // closed at bar 7's open, exit commission paid
  });

  it("a position closed at the end of the data pays its exit costs in the final equity point", () => {
    const r = withCosts(LONG_DATA.slice(0, 6), "long", { commission: 10 }); // still open at bar 5, close 11
    assert.equal(r.trades[0].exitReason, "end-of-data");
    near(r.equity[5].value, (9990 * 11) / 9.6 - 10); // 11436.875, not the 11446.875 mark
    near(r.stats.finalEquity, 11436.875);
  });

  it("a gross winner can be a net loser, and the stats use the net result", () => {
    const data = fromOC([10, 9.5, 8.5, 8.7, 9.6, 10.5, 10.8, 9.62], [10, 9, 8, 9, 10, 11, 10, 9]); // exit at 9.62
    const gross = withCosts(data, "long", {});
    assert.ok(gross.trades[0].returnPct > 0);
    assert.equal(gross.stats.winRatePct, 100);
    const net = withCosts(data, "long", { slippagePct: 1 });
    near(net.trades[0].returnPct, -1.77599, 1e-4); // 9.5238 / 9.696
    assert.equal(net.stats.winRatePct, 0);
    assert.equal(net.stats.profitFactor, 0);
  });

  it("stats: net return, final equity and total costs include the costs", () => {
    const s = withCosts(LONG_DATA, "long", { commission: 10 }).stats;
    near(s.netReturnPct, -2.28125);
    near(s.finalEquity, 9771.875);
    near(s.netProfit, -228.125);
    near(s.totalCosts, 19.7917, 1e-3);
  });
});

describe("costs on a short: market 10.8 in, 8.64 out", () => {
  const free = withCosts(SHORT_DATA, "short", {});

  it("with no costs the short is exactly as before (+20%) and costs nothing", () => {
    near(free.trades[0].returnPct, 20);
    assert.equal(free.trades[0].costs, 0);
  });

  it("slippage 1%: sells 1% LOWER (10.692) and covers 1% HIGHER (8.7264)", () => {
    // 10000 * (2 - 8.7264 / 10.692) = 11838.38 -> +18.38384%; the free short ends at 12000
    const r = withCosts(SHORT_DATA, "short", { slippagePct: 1 });
    const [t] = r.trades;
    assert.equal(t.direction, "short");
    near(t.entryPrice, 10.692, 1e-9);
    near(t.exitPrice, 8.7264, 1e-9);
    assert.ok(t.entryPrice < t.marketEntryPrice, "a short sells below the market");
    assert.ok(t.exitPrice > t.marketExitPrice, "a cover buys above the market");
    near(t.returnPct, 18.38384, 1e-4);
    near(t.costs, 161.6162, 1e-3);
  });

  it("spread 2% costs the same as slippage 1%", () => {
    const spread = withCosts(SHORT_DATA, "short", { spreadPct: 2 });
    const slip = withCosts(SHORT_DATA, "short", { slippagePct: 1 });
    near(spread.stats.finalEquity, slip.stats.finalEquity, 1e-9);
    near(spread.trades[0].entryPrice, slip.trades[0].entryPrice, 1e-12);
  });

  it("commission $10 per order: 9990 * 1.2 - 10 = 11978", () => {
    const [t] = withCosts(SHORT_DATA, "short", { commission: 10 }).trades;
    near(t.returnPct, 19.78, 1e-9);
    near(t.costs, 22, 1e-9); // 12000 - 11978
  });

  it("all three together: x = 0.5%, commission $20", () => {
    // Fin 10.746, Fout 8.6832, capital 9980: 9980 * (2 - 8.6832 / 10.746) - 20 = 11875.76
    const r = withCosts(SHORT_DATA, "short", { spreadPct: 0.4, slippagePct: 0.3, commission: 20 });
    const [t] = r.trades;
    near(t.entryPrice, 10.746, 1e-9);
    near(t.exitPrice, 8.6832, 1e-9);
    near(t.returnPct, 18.75759, 1e-4);
    near(t.costs, 124.2412, 1e-3);
    near(r.stats.finalEquity, 11875.7588, 1e-3);
  });

  it("every cost makes the short worse and none makes it better", () => {
    for (const c of [{ spreadPct: 0.5 }, { slippagePct: 0.5 }, { commission: 5 }]) {
      const t = withCosts(SHORT_DATA, "short", c).trades[0];
      assert.ok(t.returnPct < free.trades[0].returnPct, JSON.stringify(c));
      assert.ok(t.costs > 0, JSON.stringify(c));
    }
  });

  it("equity is marked with the inverted payoff after the entry commission", () => {
    const r = withCosts(SHORT_DATA, "short", { commission: 10 });
    near(r.equity[4].value, 9990 * (2 - 10 / 10.8)); // 10730.00
    near(r.equity[8].value, 11978);
    near(r.stats.finalEquity, 11978);
  });

  it("a gross winner can be a net loser for a short too", () => {
    const data = fromOC([10, 10.5, 11.5, 12, 10.8, 9.5, 8.8, 8.2, 10.7], [10, 11, 12, 11, 10, 9, 8, 9, 10]); // cover at 10.7
    assert.ok(withCosts(data, "short", {}).trades[0].returnPct > 0);
    const net = withCosts(data, "short", { slippagePct: 1 });
    near(net.trades[0].returnPct, -1.07557, 1e-4); // 2 - 10.807 / 10.692
    assert.equal(net.stats.winRatePct, 0);
  });
});

describe("costs when both sides trade", () => {
  it("commission is paid on all four fills of a short that reverses into a long", () => {
    // short: 9990 * 1.2 - 10 = 11978. long from that account: (11978 - 10) * 10 / 8.64 - 10 = 13841.85
    const r = withCosts(SHORT_DATA, "both", { commission: 10 });
    assert.equal(r.trades.length, 2);
    near(r.trades[0].pnl, 1978);
    near(r.trades[1].pnl, 13841.85185 - 11978, 1e-3);
    near(r.stats.finalEquity, 13841.85185, 1e-3);
    near(r.stats.totalCosts, 22 + 21.57407, 1e-3);
    assert.equal(r.stats.totalCosts, r.trades[0].costs + r.trades[1].costs);
  });

  it("a short reversing into a long covers and buys at the SAME ask", () => {
    const [s, l] = withCosts(SHORT_DATA, "both", { slippagePct: 1 }).trades;
    near(s.exitPrice, 8.64 * 1.01, 1e-9);
    assert.equal(l.entryPrice, s.exitPrice);
  });

  it("a long reversing into a short sells and shorts at the SAME bid, and back again at the ask", () => {
    const rsi: Strategy = { type: "rsi", period: 2, oversold: 30, overbought: 70 };
    const data = fromOC(
      [10, 10.5, 11.5, 11.5, 10.5, 9.5, 9.2, 10.5, 12.5, 11, 10],
      [10, 11, 12, 11, 10, 9, 10, 12, 12, 10, 10],
    );
    const [l1, s, l2] = withCosts(data, "both", { slippagePct: 1 }, rsi).trades;
    assert.deepEqual([l1.direction, s.direction, l2.direction], ["long", "short", "long"]);
    near(l1.exitPrice, 12.5 * 0.99, 1e-9);
    assert.equal(s.entryPrice, l1.exitPrice, "one bid");
    near(s.exitPrice, 10 * 1.01, 1e-9);
    assert.equal(l2.entryPrice, s.exitPrice, "one ask");
  });
});

// ---------------------------------------------------------------------------------------------
// Stops and targets are measured from the QUOTED entry price (10 here), so costs never move
// them: the same candle triggers the same exit with or without costs, and the exit fill then
// pays costs on top. 2% slippage, so the entry fills at 10.2 (long) or 9.8 (short).
//   long : stop 9, target 11      short: stop 11, target 9
// ---------------------------------------------------------------------------------------------
describe("stops, targets and liquidation with costs", () => {
  const longSetup: [number, number, number, number][] = [
    [10, 10.5, 9.5, 10],
    [9, 9.5, 8.5, 9],
    [8, 8.5, 7.5, 8],
    [9, 9.5, 8.5, 9],
  ];
  const shortSetup: [number, number, number, number][] = [
    [10, 10.5, 9.5, 10],
    [10, 11.5, 9.8, 11],
    [11, 12.5, 10.8, 12],
    [12, 12.3, 10.8, 11],
  ];
  const slip = { slippagePct: 2 };
  const longs = (next: [number, number, number, number][], c: Partial<Costs> = slip, sl = 10, tp = 10) =>
    runBacktest(bars([...longSetup, ...next]), cfg(MA_1_2, sl, tp, "stop-first", "long", c));
  const shorts = (
    next: [number, number, number, number][],
    c: Partial<Costs> = slip,
    sl: number | null = 10,
    tp: number | null = 10,
  ) => runBacktest(bars([...shortSetup, ...next]), cfg(MA_1_2, sl, tp, "stop-first", "short", c));

  it("long: the stop is 10% under the 10 QUOTE (9.0), and the sale then pays 2%", () => {
    const bar: [number, number, number, number] = [10, 10.3, 8.95, 9.5]; // low 8.95 goes through 9.0
    const [t] = longs([bar]).trades;
    assert.equal(t.exitReason, "stop-loss");
    near(t.marketExitPrice, 9, 1e-9);
    near(t.exitPrice, 9 * 0.98, 1e-9); // 8.82
    near(t.returnPct, -13.52941, 1e-4); // 8.82 / 10.2 - 1: the 10% stop plus both slippages
    assert.equal(longs([bar], {}).trades[0].marketExitPrice, 9, "without costs the same candle stops at the same 9.0");
  });

  it("long: a low between the old fill-based level (9.18) and the quote-based stop (9.0) does not stop us", () => {
    const bar: [number, number, number, number] = [10, 10.3, 9.1, 9.5];
    assert.equal(longs([bar]).trades[0].exitReason, "end-of-data");
    assert.equal(longs([bar], {}).trades[0].exitReason, "end-of-data");
  });

  it("long: the target is 10% over the quote (11), and the sale gets 2% less", () => {
    const [t] = longs([[10, 11.3, 9.8, 11]]).trades;
    assert.equal(t.exitReason, "take-profit");
    near(t.marketExitPrice, 11, 1e-9);
    near(t.exitPrice, 10.78, 1e-9);
    near(t.returnPct, 5.68627, 1e-4); // 10.78 / 10.2 - 1
  });

  it("long: a gap through the stop fills at the open, then pays costs", () => {
    const [t] = longs([
      [10, 10.3, 9.9, 10],
      [8, 8.5, 7.5, 8.2],
    ]).trades;
    near(t.marketExitPrice, 8, 1e-9);
    near(t.exitPrice, 7.84, 1e-9);
    near(t.returnPct, -23.13725, 1e-4); // 7.84 / 10.2 - 1
  });

  it("short: the stop is 10% over the 10 quote (11.0), and the cover then pays 2%", () => {
    const bar: [number, number, number, number] = [10, 11.05, 9.5, 10.5]; // high 11.05 goes through 11.0
    const [t] = shorts([bar]).trades;
    assert.equal(t.exitReason, "stop-loss");
    near(t.marketExitPrice, 11, 1e-9);
    near(t.exitPrice, 11 * 1.02, 1e-9); // 11.22
    near(t.returnPct, -14.48980, 1e-4); // 1 - 11.22 / 9.8: the 10% stop plus both slippages
    assert.equal(shorts([bar], {}).trades[0].marketExitPrice, 11, "without costs the same candle stops at the same 11.0");
  });

  it("short: a high between the old fill-based level (10.78) and the quote-based stop (11.0) does not stop us", () => {
    const bar: [number, number, number, number] = [10, 10.8, 9.5, 10.5];
    assert.equal(shorts([bar]).trades[0].exitReason, "end-of-data");
    assert.equal(shorts([bar], {}).trades[0].exitReason, "end-of-data");
  });

  it("short: the target is 10% under the quote (9.0), and the cover pays 2% more", () => {
    const [t] = shorts([[10, 10.2, 8.95, 9.0]]).trades;
    assert.equal(t.exitReason, "take-profit");
    near(t.marketExitPrice, 9, 1e-9);
    near(t.exitPrice, 9.18, 1e-9);
    near(t.returnPct, 6.32653, 1e-4); // 1 - 9.18 / 9.8
  });

  it("costs do not move the target: the same candle exits with or without them", () => {
    // 5% target on a long quoted at 10, so 10.5. Bar 4 reaches 10.55; bar 5 gaps far above.
    const bar4: [number, number, number, number] = [10, 10.55, 9.9, 10.3];
    const bar5: [number, number, number, number] = [12, 12.5, 11.8, 12.2];
    const run = (c: Partial<Costs>) =>
      runBacktest(bars([...longSetup, bar4, bar5]), cfg(MA_1_2, null, 5, "stop-first", "long", c));
    const free = run({}).trades[0];
    const paid = run({ slippagePct: 1 }).trades[0];
    assert.deepEqual([free.exitIndex, free.marketExitPrice], [4, 10.5]);
    assert.deepEqual([paid.exitIndex, paid.marketExitPrice], [4, 10.5], "the costed trade exits on the same candle");
    near(free.returnPct, 5, 1e-9);
    near(paid.exitPrice, 10.395, 1e-9); // 10.5 less 1%
    near(paid.returnPct, 2.92079, 1e-4); // 10.395 / 10.1 - 1
    assert.ok(run({ slippagePct: 1 }).stats.finalEquity < run({}).stats.finalEquity);
  });

  // ---- short liquidation -------------------------------------------------------------------
  // A short is wiped out at the market price where covering leaves nothing after costs:
  //   level = entryFill * (2 - commission / capital) / (1 + edge)      (no costs: exactly 2 x the quote)

  it("with no costs the liquidation level is exactly double the entry quote", () => {
    assert.equal(shorts([[10, 19.99, 9.5, 15]], {}, null, null).trades[0].exitReason, "end-of-data");
    const [t] = shorts([[10, 20, 9.5, 15]], {}, null, null).trades;
    assert.deepEqual([t.exitReason, t.marketExitPrice, t.returnPct], ["liquidated", 20, -100]);
  });

  it("with 2% slippage the level is 9.8 * 2 / 1.02 = 19.2157, where the cover fill (19.6) equals twice the entry fill", () => {
    const [t] = shorts([[10, 19.3, 9.5, 15]], slip, null, null).trades;
    assert.equal(t.exitReason, "liquidated");
    near(t.marketExitPrice, 19.215686, 1e-5);
    near(t.exitPrice, 19.6, 1e-9);
    near(t.returnPct, -100, 1e-9);
    near(t.pnl, -10000, 1e-6);
  });

  it("costs can liquidate a short that would survive without them: the one exit costs can trigger", () => {
    const bar: [number, number, number, number] = [10, 19.3, 9.5, 15]; // below 20, above 19.2157
    assert.equal(shorts([bar], {}, null, null).trades[0].exitReason, "end-of-data");
    assert.equal(shorts([bar], slip, null, null).trades[0].exitReason, "liquidated");
  });

  it("commission lowers the level: capital is the 9,900 left after the $100 entry fee (not the 10,000 account), so 10 * (2 - 100 / 9900) = 19.89899, not 19.9", () => {
    const bar: [number, number, number, number] = [10, 19.95, 9.5, 15];
    assert.equal(shorts([bar], {}, null, null).trades[0].exitReason, "end-of-data");
    const [t] = shorts([bar], { commission: 100 }, null, null).trades;
    assert.equal(t.exitReason, "liquidated");
    near(t.marketExitPrice, 19.89899, 1e-5);
    near(t.returnPct, -100, 1e-6);
    // A high of 19.8995 is above 19.89899 but below 19.9: it must liquidate, which the 10,000-based level would miss.
    assert.equal(shorts([[10, 19.8995, 9.5, 15]], { commission: 100 }, null, null).trades[0].exitReason, "liquidated");
    // Covering at 19.9 would leave 9,900 * (2 - 1.99) - 100 = -1: already underwater.
    near(9900 * (2 - 19.9 / 10) - 100, -1, 1e-9);
  });

  it("a stop set beyond the liquidation level cannot save the account: liquidation comes first", () => {
    // 99% stop = 19.9. With 5% slippage the level is 9.5 * 2 / 1.05 = 18.095, so a high of 19 liquidates.
    const bar: [number, number, number, number] = [10, 19, 9.5, 12];
    const [t] = shorts([bar], { slippagePct: 5 }, 99, null).trades;
    assert.equal(t.exitReason, "liquidated");
    near(t.marketExitPrice, 18.095238, 1e-5);
    assert.equal(shorts([bar], {}, 99, null).trades[0].exitReason, "end-of-data", "without costs the 19.9 stop is not reached");
  });

  it("a stop inside the liquidation level still acts as an ordinary stop-loss", () => {
    const [t] = shorts([[10, 11.05, 9.5, 10.5]], slip, 10, null).trades;
    assert.equal(t.exitReason, "stop-loss");
  });

  it("just under the level the account is alive and marked positive", () => {
    // high 19.1 < 19.2157: not liquidated. Marked at the 19.1 close: 10000 * (2 - 19.1 / 9.8) = 510.20.
    const r = shorts(
      [
        [10, 19.1, 9.5, 19.1],
        [19.1, 19.15, 19.0, 19.1],
      ],
      slip,
      null,
      null,
    );
    near(r.equity[4].value, 510.2041, 1e-3);
    // The spike is also a cross up, so the short covers at bar 5's open (19.1) and that buy pays 2%:
    // 19.482 against a 9.8 entry leaves 10000 * (2 - 19.482 / 9.8) = 120.41.
    const [t] = r.trades;
    assert.equal(t.exitReason, "signal");
    near(t.exitPrice, 19.482, 1e-9);
    near(r.equity[5].value, 120.4082, 1e-3);
    near(t.returnPct, -98.79592, 1e-4);
  });

  it("an account with nothing left to invest is already gone, with no NaN anywhere", () => {
    // $20000 commission against a $10000 account: nothing to invest, so the level is the entry itself.
    const r = shorts([[10, 10.2, 9.9, 10]], { commission: 20000 }, null, null);
    const [t] = r.trades;
    assert.equal(t.exitReason, "liquidated");
    assert.equal(t.marketExitPrice, 10);
    assert.deepEqual([t.returnPct, r.stats.finalEquity], [-100, 0]);
    assert.ok(r.equity.every((p) => Number.isFinite(p.value) && p.value >= 0));
  });

  it("once the account is wiped out, later trades report nothing rather than NaN", () => {
    // Liquidated on bar 4; the spike and the crash that follow keep raising signals in both mode.
    const r = runBacktest(
      bars([
        ...shortSetup,
        [10, 20, 9.5, 15],
        [15, 16, 5, 6],
        [6, 7, 5, 6.5],
        [6.5, 8, 6, 7.5],
      ]),
      cfg(MA_1_2, null, null, "stop-first", "both", {}),
    );
    assert.equal(r.trades[0].exitReason, "liquidated");
    assert.ok(r.trades.length >= 2, "there are trades after the wipe-out");
    for (const t of r.trades.slice(1)) assert.deepEqual([t.returnPct, t.pnl, t.costs], [0, 0, 0]);
    // A short opened with nothing to invest is gone the moment it opens, not left running.
    const later = r.trades.filter((t, i) => i > 0 && t.direction === "short");
    assert.ok(later.length >= 1, "a short is opened after the wipe-out");
    for (const t of later) assert.deepEqual([t.exitReason, t.exitIndex === t.entryIndex], ["liquidated", true]);
    assert.deepEqual(r.equity.slice(4).map((p) => p.value), [0, 0, 0, 0]);
    assert.equal(r.stats.netReturnPct, -100);
  });

  it("commission can take the last of a small account: the loss stops at -100%", () => {
    const r = shorts([[10, 19.7, 9.5, 15]], { slippagePct: 2, commission: 15 }, null, null);
    assert.equal(r.trades[0].exitReason, "liquidated");
    near(r.trades[0].returnPct, -100, 1e-6);
    assert.ok(r.equity.every((p) => p.value >= 0));
  });
});

// ---------------------------------------------------------------------------------------------
// Properties on random data.
// ---------------------------------------------------------------------------------------------
describe("costs never help (random data)", () => {
  const walk = randomWalk();
  const strategies: [string, Strategy][] = [
    ["MA 3/8", { type: "ma-cross", fast: 3, slow: 8 }],
    ["RSI 5 25/70", { type: "rsi", period: 5, oversold: 25, overbought: 70 }],
  ];
  const steps: Partial<Costs>[] = [
    {},
    { slippagePct: 0.05 },
    { slippagePct: 0.2 },
    { spreadPct: 0.4, slippagePct: 0.2 },
    { spreadPct: 0.4, slippagePct: 0.2, commission: 15 },
  ];

  for (const [name, strategy] of strategies) {
    for (const mode of ["long", "short", "both"] as const) {
      it(`${name}, ${mode}, no stops or targets: costs leave the trades alone and strictly shrink the account`, () => {
        // Only true with stops and targets OFF. With them on, levels are measured from the entry fill, so costs
        // can move a level, change which candle triggers it and re-sequence later trades (see the tests below).
        const runs = steps.map((c) => runBacktest(walk, cfg(strategy, null, null, "stop-first", mode, c)));
        const shape = (r: (typeof runs)[number]) => r.trades.map((t) => [t.direction, t.entryIndex, t.exitIndex]);
        assert.ok(runs[0].trades.length >= 3, "not vacuous");
        for (const r of runs) assert.deepEqual(shape(r), shape(runs[0]));
        for (let k = 1; k < runs.length; k++) {
          assert.ok(runs[k].stats.finalEquity < runs[k - 1].stats.finalEquity, `step ${k} is not cheaper than step ${k - 1}`);
        }
      });
    }
  }

  // Stops and targets are measured from the quote, so costs cannot move them either.
  const stopPairs: [number | null, number | null][] = [
    [3, 5],
    [4, 8],
    [2, null],
    [null, 3],
  ];
  for (const [name, strategy] of strategies) {
    for (const mode of ["long", "short", "both"] as const) {
      it(`${name}, ${mode}, stops and targets ON: costs leave the trades alone and strictly shrink the account`, () => {
        for (const [sl, tp] of stopPairs) {
          const runs = steps.map((c) => runBacktest(walk, cfg(strategy, sl, tp, "stop-first", mode, c)));
          const shape = (r: (typeof runs)[number]) => r.trades.map((t) => [t.direction, t.entryIndex, t.exitIndex, t.exitReason]);
          assert.ok(runs[0].trades.length >= 3, `not vacuous (stop ${sl}, target ${tp})`);
          // Liquidation depends on the account after costs, so it is the one exit costs can add; none occurs here.
          for (const r of runs) assert.ok(r.trades.every((t) => t.exitReason !== "liquidated"));
          for (const r of runs) assert.deepEqual(shape(r), shape(runs[0]), `stop ${sl}, target ${tp}`);
          for (let k = 1; k < runs.length; k++) {
            assert.ok(runs[k].stats.finalEquity < runs[k - 1].stats.finalEquity, `stop ${sl}, target ${tp}: step ${k}`);
          }
        }
      });
    }
  }

  const stopped: [string, BacktestConfig][] = [
    [
      "MA 3/8 short, stop 3%, target 5%, costs",
      cfg(strategies[0][1], 3, 5, "by-candle-colour", "short", { spreadPct: 0.2, slippagePct: 0.1, commission: 8 }),
    ],
    [
      "RSI both, stop 4%, target 6%, costs",
      cfg(strategies[1][1], 4, 6, "target-first", "both", { spreadPct: 0.3, slippagePct: 0.15, commission: 5 }),
    ],
    [
      "MA 5/20 both, no stop, costs",
      cfg({ type: "ma-cross", fast: 5, slow: 20 }, null, null, "stop-first", "both", { slippagePct: 0.1, commission: 12 }),
    ],
  ];

  for (const [name, config] of stopped) {
    const full = runBacktest(walk, config);

    it(`${name}: per-trade costs are positive and add up`, () => {
      assert.ok(full.trades.length >= 3);
      for (const t of full.trades) assert.ok(t.costs > 0, `trade at ${t.entryIndex} cost ${t.costs}`);
      near(full.stats.totalCosts, full.trades.reduce((a, t) => a + t.costs, 0), 1e-9);
    });

    it(`${name}: final equity equals the start plus every trade's P&L and the compounded net returns`, () => {
      near(full.stats.finalEquity, INITIAL_CAPITAL + full.trades.reduce((a, t) => a + t.pnl, 0), 1e-6);
      near(full.stats.finalEquity, full.trades.reduce((a, t) => a * (1 + t.returnPct / 100), INITIAL_CAPITAL), 1e-6);
      assert.ok(full.equity.every((p) => p.value >= 0));
    });

    it(`${name}: fills are always on the unfavourable side of the market`, () => {
      for (const t of full.trades) {
        if (t.direction === "long") assert.ok(t.entryPrice >= t.marketEntryPrice && t.exitPrice <= t.marketExitPrice);
        else assert.ok(t.entryPrice <= t.marketEntryPrice && t.exitPrice >= t.marketExitPrice);
      }
    });

    for (const cut of [60, 133, 250]) {
      it(`${name}: truncating at bar ${cut} changes no earlier decision`, () => {
        const part = runBacktest(walk.slice(0, cut), config);
        const settled = part.trades.filter((t) => t.exitReason !== "end-of-data");
        assert.deepEqual(settled, full.trades.slice(0, settled.length));
        // The last point of a truncated run is the forced close, which pays exit costs; the rest must match.
        assert.deepEqual(part.equity.slice(0, cut - 1), full.equity.slice(0, cut - 1));
      });
    }
  }
});

// ---------------------------------------------------------------------------------------------
// "both" against long and short run separately. Percentage costs compound, so the two agree.
// A fixed dollar commission does not: its weight depends on the account the trade happens in.
// ---------------------------------------------------------------------------------------------
describe("both mode against long and short run separately", () => {
  const walk = randomWalk();
  const strategy: Strategy = { type: "ma-cross", fast: 3, slow: 8 };
  const sets = (c: Partial<Costs>) => {
    const r = (mode: TradeMode) => runBacktest(walk, cfg(strategy, 3, 5, "stop-first", mode, c));
    const [long, short, both] = [r("long"), r("short"), r("both")];
    const key = (t: { direction: string; entryIndex: number; exitIndex: number; exitReason: string }) =>
      `${t.direction}|${t.entryIndex}|${t.exitIndex}|${t.exitReason}`;
    return {
      sameTrades: JSON.stringify([...long.trades, ...short.trades].map(key).sort()) === JSON.stringify(both.trades.map(key).sort()),
      product: (long.stats.finalEquity / INITIAL_CAPITAL) * (short.stats.finalEquity / INITIAL_CAPITAL) * INITIAL_CAPITAL,
      both: both.stats.finalEquity,
    };
  };

  it("with no costs, both is exactly long x short", () => {
    const r = sets({});
    assert.ok(r.sameTrades);
    near(r.both, r.product, 1e-6);
  });

  it("with spread and slippage only, both is still exactly long x short", () => {
    const r = sets({ spreadPct: 0.3, slippagePct: 0.15 });
    assert.ok(r.sameTrades);
    near(r.both, r.product, 1e-6);
  });

  it("with a fixed commission the same trades give a different total, because $5 weighs more on a smaller account", () => {
    const r = sets({ commission: 25 });
    assert.ok(r.sameTrades, "still the same trades; only the commission's weight differs");
    assert.ok(Math.abs(r.both - r.product) > 1, `both ${r.both.toFixed(2)} vs long x short ${r.product.toFixed(2)}`);
  });
});

describe("parseCost", () => {
  it("reads empty as zero and numbers as themselves", () => {
    assert.equal(parseCost(""), 0);
    assert.equal(parseCost("  "), 0);
    assert.equal(parseCost("0.25"), 0.25);
  });
  it("turns unparseable input into NaN that blocks the run, rather than zero", () => {
    // A number input reports "" for text like "1e", so only the badInput flag tells it from empty.
    assert.ok(Number.isNaN(parseCost("", true)));
    assert.ok(Number.isNaN(parseCost("abc")));
    const costs = { spreadPct: 0, slippagePct: parseCost("", true), commission: 0 };
    assert.match(validateConfig({ ...cfg(MA_1_2), costs }) ?? "", /Slippage must be a number/);
  });
});

describe("validateConfig: costs", () => {
  const ok = cfg(MA_1_2);
  const bad = (costs: Costs): BacktestConfig => ({ ...ok, costs });
  it("accepts zero and positive costs, and no costs at all", () => {
    assert.equal(validateConfig({ ...ok, costs: undefined }), null);
    assert.equal(validateConfig(bad({ spreadPct: 0, slippagePct: 0, commission: 0 })), null);
    assert.equal(validateConfig(bad({ spreadPct: 0.2, slippagePct: 0.1, commission: 4.5 })), null);
  });
  it("rejects negative, non-numeric and infinite costs", () => {
    for (const c of [
      { spreadPct: -0.1, slippagePct: 0, commission: 0 },
      { spreadPct: 0, slippagePct: -1, commission: 0 },
      { spreadPct: 0, slippagePct: 0, commission: -5 },
      { spreadPct: NaN, slippagePct: 0, commission: 0 },
      { spreadPct: 0, slippagePct: Infinity, commission: 0 },
      { spreadPct: 0, slippagePct: 0, commission: Infinity }, // only the finite check can catch this one
      { spreadPct: 0, slippagePct: 0, commission: NaN },
    ]) {
      assert.ok(validateConfig(bad(c)), JSON.stringify(c));
    }
  });
  it("rejects costs so large a sale would receive nothing", () => {
    assert.ok(validateConfig(bad({ spreadPct: 0, slippagePct: 100, commission: 0 })));
    assert.ok(validateConfig(bad({ spreadPct: 200, slippagePct: 0, commission: 0 })));
    assert.equal(validateConfig(bad({ spreadPct: 0, slippagePct: 99, commission: 0 })), null);
  });
});
