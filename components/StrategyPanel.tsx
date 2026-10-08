"use client";

import { useState } from "react";
import { validateConfig, type BacktestConfig } from "@/lib/backtest";

type Kind = "ma-cross" | "rsi";

const INPUT =
  "w-24 rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700";

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
      {label}
      <input
        type="number"
        inputMode="decimal"
        className={INPUT}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

export default function StrategyPanel({ onRun }: { onRun: (cfg: BacktestConfig) => void }) {
  const [kind, setKind] = useState<Kind>("ma-cross");
  const [fast, setFast] = useState("10");
  const [slow, setSlow] = useState("30");
  const [period, setPeriod] = useState("14");
  const [oversold, setOversold] = useState("30");
  const [overbought, setOverbought] = useState("70");
  const [stopLoss, setStopLoss] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Empty means "disabled"; anything else must parse, which validateConfig then range-checks.
  const optional = (s: string) => (s.trim() === "" ? null : Number(s));

  function run() {
    const cfg: BacktestConfig = {
      strategy:
        kind === "ma-cross"
          ? { type: "ma-cross", fast: Number(fast), slow: Number(slow) }
          : { type: "rsi", period: Number(period), oversold: Number(oversold), overbought: Number(overbought) },
      stopLossPct: optional(stopLoss),
      takeProfitPct: optional(takeProfit),
    };
    const problem = validateConfig(cfg) ?? (Object.values(cfg.strategy).some(Number.isNaN) ? "Enter a number in every field." : null);
    setError(problem);
    if (!problem) onRun(cfg);
  }

  return (
    <section className="space-y-4 rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="text-sm font-semibold">Strategy</h2>

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
          Type
          <select
            className={`${INPUT} w-52`}
            value={kind}
            onChange={(e) => setKind(e.target.value as Kind)}
          >
            <option value="ma-cross">Moving average crossover</option>
            <option value="rsi">RSI</option>
          </select>
        </label>

        {kind === "ma-cross" ? (
          <>
            <Field label="Fast period" value={fast} onChange={setFast} />
            <Field label="Slow period" value={slow} onChange={setSlow} />
          </>
        ) : (
          <>
            <Field label="RSI period" value={period} onChange={setPeriod} />
            <Field label="Oversold (buy)" value={oversold} onChange={setOversold} />
            <Field label="Overbought (sell)" value={overbought} onChange={setOverbought} />
          </>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <Field label="Stop loss %" value={stopLoss} onChange={setStopLoss} placeholder="off" />
        <Field label="Take profit %" value={takeProfit} onChange={setTakeProfit} placeholder="off" />
        <button
          type="button"
          onClick={run}
          className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
        >
          Run backtest
        </button>
      </div>

      <p className="text-xs text-zinc-500">
        {kind === "ma-cross"
          ? "Buys when the fast average crosses above the slow one; sells on the cross back down."
          : "Buys when RSI falls through the oversold level; sells once RSI reaches overbought."}{" "}
        Long only, fills at the next bar&apos;s open.
      </p>

      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
    </section>
  );
}
