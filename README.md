# Backtester

Backtest simple strategies on your own candle data, in the browser. Nothing is uploaded anywhere: files are read and processed locally.

Built with Next.js 16, React 19, Tailwind 4 and TradingView's [lightweight-charts](https://github.com/tradingview/lightweight-charts).

```bash
npm install
npm run dev      # http://localhost:3000
npm test         # unit and property tests
npm run lint
npm run build
```

## Loading data

**CSV.** One row per day with the columns `date, open, high, low, close, volume` (any order, any letter case):

```csv
date,open,high,low,close,volume
2024-01-02,100.41,101.14,99.99,100.39,909661
```

Dates must be `YYYY-MM-DD`. Rows that are malformed, have non-positive prices, an inconsistent high or low, or a repeated date are rejected with the line number and reason; the rest still load. A sample is in [`public/sample-candles.csv`](public/sample-candles.csv).

**PNG chart image.** Screenshots of a chart can be turned into candles. Pick the bullish and bearish colours (or click them on the image), enter the prices at the top and bottom of the price axis, and compare the original with the rebuilt chart before using it. If the screenshot has margins or a volume panel, set the top and bottom rows so only the price area is read.

It works best on a clean, linear-scale chart with solid two-colour candles. Hollow candles, log scales, candles that touch with no gap, and indicator lines in the candle colours will not read correctly. Volume is not in an image, so it is set to 0, and only daily, weekly and monthly spacing is supported.

## Strategies

| Strategy | Long | Short (the mirror image) |
|---|---|---|
| Moving average crossover | Buy when the fast average crosses above the slow one; sell on the cross back down | Sell short on the cross down; cover on the cross up |
| RSI (Wilder's smoothing) | Buy when RSI falls through the oversold level; sell once it reaches overbought | Sell short as RSI rises through overbought; cover once it drops to oversold |

Choose **long**, **short** or **both**. In "both" mode each exit also opens the opposite side at the same price (stop and reverse). Entries need a fresh crossing; sitting beyond a level does not trigger one.

## How a backtest is simulated

- **No look-ahead.** A signal is read at a candle's close and filled at the **next** candle's open. Tests check that rewriting or deleting every later candle never changes an earlier decision.
- **One position at a time, all-in**, starting from $10,000, compounding. No leverage.
- **Stop loss and take profit** are percentages of the quoted entry price (below it for a long, above it for a short), checked from the entry candle onward. A candle that gaps past a level fills at its open, not at the level.
- **One candle reaching both levels** cannot be ordered from daily data, so you choose: assume the stop first (cautious, the default), the target first, or guess from the candle's colour. Trades that relied on the assumption are marked `*`.
- **Costs.** Spread (split half each way) and slippage move every fill against you: buys pay more, sells receive less, for longs and shorts alike. Commission is a fixed dollar amount per order, paid on entry and again on exit. All results are net of costs, and costs never change which trades happen. Stops and targets come from the quote, not the fill.
- **Short liquidation.** A short can lose more than its account. It is closed as "liquidated" at the market price where covering would leave nothing after costs (double the entry with no costs). If a stop is set beyond that price, liquidation comes first. There are no borrowing costs.
- **Equity** is marked to the close on every candle, so drawdown includes open positions.

Comparisons treat values within one part in 10^12 as equal, so a stop that is exactly a price to the cent, or two averages that are mathematically level, are not decided by floating-point rounding.

## Performance

Every pipeline stage is linear. On a production build, a 100,000-candle file parses and charts in about 3 s and a backtest of it (11,000 trades) renders in under 1 s. The trades table shows the latest 500 trades until you ask for all of them, and the chart draws arrows only for the trades in view (at most 1,000). CSV parsing runs on the main thread, so a file near the 20 MB limit can freeze the page for a second or two.

## Layout

```
app/            Next.js app shell
components/     UI only: upload, charts, strategy panel, results
lib/            All logic, with no DOM or React
  indicators.ts   SMA and RSI
  backtest.ts     signals, simulation, costs, stats
  parseCandles.ts CSV parsing and validation
  imageCandles.ts reading candles out of a chart image
  visibleTrades.ts which trades to draw for the part of the chart on screen
tests/          node:test suites, run with tsx
```

Tests use hand-calculated datasets for each rule, plus properties over random data (no look-ahead, no overlapping trades, accounting always balances, costs only ever hurt).
