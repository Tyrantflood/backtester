"use client";

import { useEffect, useRef } from "react";
import { ColorType, CrosshairMode, LineSeries, createChart, type UTCTimestamp } from "lightweight-charts";
import type { EquityPoint } from "@/lib/backtest";

const STRATEGY = "#2563eb";
const HELD = "#a1a1aa";

const toTime = (date: string) => (Date.parse(`${date}T00:00:00Z`) / 1000) as UTCTimestamp;

export default function EquityChart({ equity, benchmark }: { equity: EquityPoint[]; benchmark: EquityPoint[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || equity.length === 0) return;

    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const grid = dark ? "#27272a" : "#e4e4e7";

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: dark ? "#a1a1aa" : "#52525b",
      },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: grid },
      timeScale: { borderColor: grid },
    });

    const held = chart.addSeries(LineSeries, { color: HELD, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    held.setData(benchmark.map((p) => ({ time: toTime(p.date), value: p.value })));
    const strategy = chart.addSeries(LineSeries, { color: STRATEGY, lineWidth: 2, priceLineVisible: false });
    strategy.setData(equity.map((p) => ({ time: toTime(p.date), value: p.value })));
    chart.timeScale().fitContent();

    return () => chart.remove();
  }, [equity, benchmark]);

  return (
    <figure className="w-full space-y-2">
      <figcaption className="flex items-center gap-4 text-xs text-zinc-500">
        <span className="font-semibold text-zinc-700 dark:text-zinc-300">Equity curve</span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4" style={{ background: STRATEGY }} /> Strategy
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4" style={{ background: HELD }} /> Buy &amp; hold
        </span>
      </figcaption>
      <div
        ref={containerRef}
        className="h-[260px] w-full rounded-md border border-zinc-200 dark:border-zinc-800"
        aria-label="Equity curve of the backtest against buy and hold"
      />
    </figure>
  );
}
