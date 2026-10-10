const STEPS = [
  ["Load candles", "Upload a CSV, or a screenshot of a chart."],
  ["Pick a strategy", "Choose the rules, stops and trading costs."],
  ["See the result", "Trades on the chart, stats and the equity curve."],
] as const;

export function Hero({
  onSample,
  loading,
  error,
}: {
  onSample: () => void;
  loading: boolean;
  error: string | null;
}) {
  return (
    <header className="space-y-5">
      <div className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Backtester</h1>
        <p className="text-lg text-zinc-800 dark:text-zinc-200 sm:text-xl">
          Test trading strategies on your own price data before risking money.
        </p>
        <p className="max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
          Load daily candles, run a moving average crossover or RSI strategy long, short or both, add
          stops and trading costs, and see every trade on the chart with win rate, drawdown and an
          equity curve against buy and hold. It all runs in your browser; your data never leaves it.
        </p>
      </div>
      <div className="flex flex-col items-start gap-2">
        <button
          type="button"
          onClick={onSample}
          disabled={loading}
          className="w-full rounded-full bg-blue-600 px-6 py-3 text-base font-medium text-white hover:bg-blue-700 disabled:opacity-60 sm:w-auto"
        >
          {loading ? "Loading…" : "Try with sample data"}
        </button>
        <p className="text-xs text-zinc-500">Loads a sample CSV and runs a 10/30 moving average crossover.</p>
        {error && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {error}
          </p>
        )}
      </div>
      <ol className="grid gap-3 sm:grid-cols-3">
        {STEPS.map(([title, text], i) => (
          <li
            key={title}
            className="flex gap-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800"
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-medium text-background">
              {i + 1}
            </span>
            <span className="text-sm">
              <strong className="font-medium">{title}</strong>
              <span className="block text-zinc-600 dark:text-zinc-400">{text}</span>
            </span>
          </li>
        ))}
      </ol>
    </header>
  );
}

export function DataHelp() {
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">CSV format</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          One row per day with a header row. Columns can be in any order; dates are YYYY-MM-DD.
        </p>
        <pre className="overflow-x-auto rounded-md bg-zinc-100 p-3 font-mono text-xs dark:bg-zinc-900">
{`date,open,high,low,close,volume
2024-01-02,100.41,101.14,99.99,100.39,909661
2024-01-03,100.95,102.47,100.57,102.22,1336199`}
        </pre>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Free: Stooq. Search a symbol on stooq.com (US stocks end in .us, e.g. aapl.us), open its
          Historical data page and use the CSV download link at the bottom.
        </p>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Also: TradingView (chart menu, Export chart data) and Yahoo Finance (a symbol&apos;s
          Historical Data tab, then Download). Both may need a paid plan for exports. Rename the
          columns to the names above if they differ, and use YYYY-MM-DD dates.
        </p>
        <a
          href="/sample-candles.csv"
          download
          className="inline-block rounded-full border border-zinc-300 px-4 py-1.5 text-sm font-medium dark:border-zinc-700"
        >
          Download sample CSV
        </a>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">What to keep in mind</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-600 dark:text-zinc-400">
          <li>A signal is read at a candle&apos;s close and filled at the next candle&apos;s open.</li>
          <li>
            If one candle reaches both your stop and your target, the cautious assumption is used by
            default: the stop was hit first. You can change it.
          </li>
          <li>Spread, slippage and commission are included when you set them; they default to zero.</li>
          <li>A backtest shows how rules would have done on past data. It is not a forecast.</li>
        </ul>
      </section>
    </div>
  );
}
