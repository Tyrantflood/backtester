"use client";

import { useState } from "react";
import BacktestResults from "@/components/BacktestResults";
import CandleChart from "@/components/CandleChart";
import CsvUpload from "@/components/CsvUpload";
import StrategyPanel from "@/components/StrategyPanel";
import { runBacktest, type BacktestResult } from "@/lib/backtest";
import type { Candle } from "@/lib/parseCandles";

export default function Workspace() {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [result, setResult] = useState<BacktestResult | null>(null);

  return (
    <>
      <CsvUpload
        onLoad={(c) => {
          setCandles(c);
          setResult(null); // results belong to the previous data set
        }}
      />
      {candles.length > 0 && (
        <>
          <section className="w-full space-y-2">
            <CandleChart candles={candles} trades={result?.trades ?? []} />
            <p className="text-xs text-zinc-500">
              Scroll to zoom, drag to pan, drag the axes to rescale.
            </p>
          </section>
          <StrategyPanel onRun={(cfg) => setResult(runBacktest(candles, cfg))} />
          {result && <BacktestResults result={result} />}
        </>
      )}
    </>
  );
}
