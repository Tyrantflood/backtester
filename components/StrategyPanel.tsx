"use client";

import { useState } from "react";
import { validateConfig, type BacktestConfig, type SameCandleRule, type TradeMode } from "@/lib/backtest";

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
  const [mode, setMode] = useState<TradeMode>("long");
  const [spread, setSpread] = useState("");
  const [slippage, setSlippage] = useState("");
  const [commission, setCommission] = useState("");
  const [sameCandle, setSameCandle] = useState<SameCandleRule>("stop-first");
  const [error, setError] = useState<string | null>(null);

  // Empty means "disabled"; anything else must parse, which validateConfig then range-checks.
  const optional = (s: string) => (s.trim() === "" ? null : Number(s));
  // Costs left empty are zero; anything unparseable stays NaN so validateConfig rejects it.
  const cost = (s: string) => (s.trim() === "" ? 0 : Number(s));

  function run() {
    const cfg: BacktestConfig = {
      strategy:
        kind === "ma-cross"
          ? { type: "ma-cross", fast: Number(fast), slow: Number(slow) }
          : { type: "rsi", period: Number(period), oversold: Number(oversold), overbought: Number(overbought) },
      stopLossPct: optional(stopLoss),
      takeProfitPct: optional(takeProfit),
      mode,
      sameCandle,
      costs: { spreadPct: cost(spread), slippagePct: cost(slippage), commission: cost(commission) },
    };
    const problem = validateConfig(cfg) ?? (Object.values(cfg.strategy).some(Number.isNaN) ? "Enter a number in every field." : null);
    setError(problem);
    if (!problem) onRun(cfg);
  }

  return (
    <section className="space-y-4 rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="text-sm font-semibold">Strategy</h2>

      <div role="radiogroup" aria-label="Trade direction" className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
        Trade
        <div className="inline-flex w-fit overflow-hidden rounded-md border border-zinc-300 dark:border-zinc-700">
          {(["long", "short", "both"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
              className={`px-4 py-1.5 text-sm capitalize ${
                mode === m ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : ""
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

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
        <Field label="Spread %" value={spread} onChange={setSpread} placeholder="0" />
        <Field label="Slippage %" value={slippage} onChange={setSlippage} placeholder="0" />
        <Field label="Commission $ / order" value={commission} onChange={setCommission} placeholder="0" />
        <label className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
          If one candle hits both
          <select
            className={`${INPUT} w-60`}
            value={sameCandle}
            onChange={(e) => setSameCandle(e.target.value as SameCandleRule)}
          >
            <option value="stop-first">Assume stop first (cautious)</option>
            <option value="target-first">Assume target first (optimistic)</option>
            <option value="by-candle-colour">By candle shape (green dips first, red rallies first)</option>
          </select>
        </label>
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
          ? "Long: buys when the fast average crosses above the slow one and sells on the cross back down. Short: the mirror image, selling on the cross down and covering on the cross up."
          : "Long: buys when RSI falls through the oversold level and sells once it reaches overbought. Short: sells as RSI rises through overbought and covers once it drops to oversold."}{" "}
        Both reverses on each signal. Spread (split half each way), slippage and commission are charged on every entry and exit, long or short, and always work against the trade. Stop loss and take profit are measured from the quoted entry price (below it for a long, above it for a short), so costs never move them; the exit then pays costs. A short with no stop, or a stop wider than its liquidation level, is closed as &quot;liquidated&quot; when the price reaches the point where covering would leave nothing. Fills at the next bar&apos;s open.
      </p>

      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
    </section>
  );
}
