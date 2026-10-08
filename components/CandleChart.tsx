"use client";

import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  createChart,
  createSeriesMarkers,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Trade } from "@/lib/backtest";
import type { Candle } from "@/lib/parseCandles";

const UP = "#16a34a";
const DOWN = "#dc2626";

function toTime(date: string): UTCTimestamp {
  return (Date.parse(`${date}T00:00:00Z`) / 1000) as UTCTimestamp;
}

export default function CandleChart({ candles, trades }: { candles: Candle[]; trades: Trade[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || candles.length === 0) return;

    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const text = dark ? "#a1a1aa" : "#52525b";
    const grid = dark ? "#27272a" : "#e4e4e7";

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: text,
      },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: grid },
      timeScale: { borderColor: grid, minBarSpacing: 0.05 },
      handleScroll: true,
      handleScale: true,
    });

    const price = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      borderVisible: false,
    });
    price.priceScale().applyOptions({ scaleMargins: { top: 0.05, bottom: 0.25 } });

    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    // Candles arrive sorted and de-duplicated by date (see parseCandlesCsv).
    price.setData(
      candles.map((c) => ({
        time: toTime(c.date),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
    volume.setData(
      candles.map((c) => ({
        time: toTime(c.date),
        value: c.volume,
        color: c.close >= c.open ? `${UP}80` : `${DOWN}80`,
      })),
    );

    createSeriesMarkers(
      price,
      // The arrow shows the order placed: up = buy, down = sell. A long buys then sells; a short
      // sells then buys back ("Cover"). The percentage is on the closing marker.
      trades.flatMap((t) => {
        const long = t.direction === "long";
        const pct = `${t.returnPct >= 0 ? "+" : ""}${t.returnPct.toFixed(1)}%`;
        const buy = (text: string) => ({
          position: "belowBar" as const,
          shape: "arrowUp" as const,
          color: UP,
          text,
        });
        const sell = (text: string) => ({
          position: "aboveBar" as const,
          shape: "arrowDown" as const,
          color: DOWN,
          text,
        });
        return [
          { time: toTime(t.entryDate), ...(long ? buy("Buy") : sell("Short")) },
          { time: toTime(t.exitDate), ...(long ? sell(`Sell ${pct}`) : buy(`Cover ${pct}`)) },
        ];
      }),
    );

    // Start on the most recent ~200 candles so a large file isn't an unreadable smear.
    const last = candles.length - 1;
    if (candles.length > 200) chart.timeScale().setVisibleLogicalRange({ from: last - 200, to: last + 5 });
    else chart.timeScale().fitContent();

    return () => chart.remove();
  }, [candles, trades]);

  return (
    <div
      ref={containerRef}
      className="h-[420px] w-full rounded-md border border-zinc-200 dark:border-zinc-800"
      aria-label={`Candlestick chart of ${candles.length} candles`}
    />
  );
}
