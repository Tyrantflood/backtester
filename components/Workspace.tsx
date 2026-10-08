"use client";

import { useState } from "react";
import BacktestResults from "@/components/BacktestResults";
import CandleChart, { MAX_MARKED_TRADES } from "@/components/CandleChart";
import CsvUpload from "@/components/CsvUpload";
import EquityChart from "@/components/EquityChart";
import ImageUpload from "@/components/ImageUpload";
import StrategyPanel from "@/components/StrategyPanel";
import { runBacktest, type BacktestResult } from "@/lib/backtest";
import type { Candle } from "@/lib/parseCandles";

const NO_TRADES: never[] = []; // stable identity so the chart isn't rebuilt on every render

type Source = "csv" | "image";

export default function Workspace() {
  const [source, setSource] = useState<Source>("csv");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [runs, setRuns] = useState(0); // keys the results so each run starts with its own table state

  function load(c: Candle[]) {
    setCandles(c);
    setResult(null); // results belong to the previous data set
  }

  const tab = (value: Source, label: string) => (
    <button
      type="button"
      role="tab"
      id={`tab-${value}`}
      aria-controls={`panel-${value}`}
      aria-selected={source === value}
      onClick={() => setSource(value)}
      className={`rounded-full px-4 py-1.5 text-sm font-medium ${
        source === value
          ? "bg-foreground text-background"
          : "border border-zinc-300 text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
      }`}
    >
      {label}
    </button>
  );

  return (
    <>
      <div role="tablist" aria-label="Data source" className="flex gap-2">
        {tab("csv", "CSV file")}
        {tab("image", "PNG chart image")}
      </div>
      {/* Both stay mounted so switching tabs doesn't throw away a half-configured upload. */}
      <div role="tabpanel" id="panel-csv" aria-labelledby="tab-csv" hidden={source !== "csv"}>
        <CsvUpload onLoad={load} />
      </div>
      <div role="tabpanel" id="panel-image" aria-labelledby="tab-image" hidden={source !== "image"}>
        <ImageUpload onLoad={load} />
      </div>

      {candles.length > 0 && (
        <>
          <section className="w-full space-y-2">
            <CandleChart candles={candles} trades={result?.trades ?? NO_TRADES} />
            <p className="text-xs text-zinc-500">
              Scroll to zoom, drag to pan, drag the axes to rescale.
              {result && result.trades.length > MAX_MARKED_TRADES
                ? ` Trade arrows are drawn for the trades in view, the latest ${MAX_MARKED_TRADES.toLocaleString("en-US")} if more are.`
                : ""}
            </p>
          </section>
          {result && <EquityChart equity={result.equity} benchmark={result.benchmark} />}
          <StrategyPanel
            onRun={(cfg) => {
              setResult(runBacktest(candles, cfg));
              setRuns((n) => n + 1);
            }}
          />
          {result && <BacktestResults key={runs} result={result} />}
        </>
      )}
    </>
  );
}
