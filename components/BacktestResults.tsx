import type { BacktestResult } from "@/lib/backtest";

const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
const money = (n: number) =>
  `${n < 0 ? "-" : "+"}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const tone = (n: number) => (n > 0 ? "text-green-600" : n < 0 ? "text-red-600" : "");
const ratio = (n: number | null) => (n === null ? "–" : Number.isFinite(n) ? n.toFixed(2) : "∞");

export default function BacktestResults({ result }: { result: BacktestResult }) {
  const { stats, trades } = result;
  const tiles: { label: string; value: string; sub?: string; cls?: string; hint?: string }[] = [
    { label: "Total trades", value: String(stats.trades) },
    { label: "Win rate", value: `${stats.winRatePct.toFixed(1)}%` },
    {
      label: "Profit factor",
      value: ratio(stats.profitFactor),
      hint: "Total of winning returns divided by total of losing returns. Above 1 means the wins outweigh the losses.",
    },
    {
      label: "Avg R:R",
      value: ratio(stats.avgRewardRisk),
      sub:
        stats.avgWinPct !== null && stats.avgLossPct !== null
          ? `+${stats.avgWinPct.toFixed(2)}% / -${stats.avgLossPct.toFixed(2)}%`
          : undefined,
      hint: "Realised reward-to-risk: average winning trade divided by average losing trade.",
    },
    {
      label: "Max drawdown",
      value: `${stats.maxDrawdownPct > 0 ? "-" : ""}${stats.maxDrawdownPct.toFixed(2)}%`,
      hint: "Largest fall from a peak of the equity curve, including open positions.",
    },
    {
      label: "Net return",
      value: pct(stats.netReturnPct),
      sub: money(stats.netProfit),
      cls: tone(stats.netReturnPct),
    },
  ];

  return (
    <section className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {tiles.map((t) => (
          <div key={t.label} title={t.hint} className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
            <p className="text-xs text-zinc-500">{t.label}</p>
            <p className={`font-mono text-lg ${t.cls ?? ""}`}>{t.value}</p>
            <p className="h-4 font-mono text-xs text-zinc-500">{t.sub}</p>
          </div>
        ))}
      </div>
      <p className="text-xs text-zinc-500">
        Buy &amp; hold over the same period: {pct(stats.buyAndHoldPct)}. Equity starts at $10,000, all-in on every
        trade, no fees.
      </p>

      {trades.some((t) => t.ambiguous) && (
        <p className="text-xs text-zinc-500">
          * One candle reached both the stop and the target, so the exit order follows your &quot;if one candle hits both&quot; setting.
        </p>
      )}

      {trades.length === 0 ? (
        <p className="text-sm text-zinc-500">No trades were triggered with these settings.</p>
      ) : (
        <div className="max-h-80 overflow-auto rounded-md border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-right font-mono text-sm">
            <thead className="sticky top-0 bg-zinc-100 font-sans dark:bg-zinc-900">
              <tr>
                {["#", "Entry", "Exit", "Entry price", "Exit price", "Return", "Bars", "Exit reason"].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium first:text-left last:text-left">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trades.map((t, n) => (
                <tr key={t.entryIndex} className="border-t border-zinc-200 dark:border-zinc-800">
                  <td className="px-3 py-1.5 text-left text-zinc-500">{n + 1}</td>
                  <td className="px-3 py-1.5">{t.entryDate}</td>
                  <td className="px-3 py-1.5">{t.exitDate}</td>
                  <td className="px-3 py-1.5">{t.entryPrice.toFixed(2)}</td>
                  <td className="px-3 py-1.5">{t.exitPrice.toFixed(2)}</td>
                  <td className={`px-3 py-1.5 ${tone(t.returnPct)}`}>{pct(t.returnPct)}</td>
                  <td className="px-3 py-1.5">{t.exitIndex - t.entryIndex + 1}</td>
                  <td className="px-3 py-1.5 text-left font-sans">
                    {t.exitReason}
                    {t.ambiguous && (
                      <span title="This candle reached both the stop and the target; the order is an assumption."> *</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
