import type { BacktestResult } from "@/lib/backtest";

const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
const tone = (n: number) => (n > 0 ? "text-green-600" : n < 0 ? "text-red-600" : "");

export default function BacktestResults({ result }: { result: BacktestResult }) {
  const { stats, trades } = result;
  const tiles: [string, string, string][] = [
    ["Trades", String(stats.trades), ""],
    ["Win rate", `${stats.winRatePct.toFixed(1)}%`, ""],
    ["Total return", pct(stats.totalReturnPct), tone(stats.totalReturnPct)],
    ["Buy & hold", pct(stats.buyAndHoldPct), tone(stats.buyAndHoldPct)],
    ["Avg trade", pct(stats.avgTradePct), tone(stats.avgTradePct)],
    ["Max drawdown", `${stats.maxDrawdownPct > 0 ? "-" : ""}${stats.maxDrawdownPct.toFixed(2)}%`, ""],
  ];

  return (
    <section className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {tiles.map(([label, value, cls]) => (
          <div key={label} className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
            <p className="text-xs text-zinc-500">{label}</p>
            <p className={`font-mono text-lg ${cls}`}>{value}</p>
          </div>
        ))}
      </div>

      {trades.length === 0 ? (
        <p className="text-sm text-zinc-500">No trades were triggered with these settings.</p>
      ) : (
        <div className="max-h-80 overflow-auto rounded-md border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-right font-mono text-sm">
            <thead className="sticky top-0 bg-zinc-100 font-sans dark:bg-zinc-900">
              <tr>
                {["Entry", "Exit", "Entry price", "Exit price", "Return", "Exit reason"].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium first:text-left last:text-left">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.entryIndex} className="border-t border-zinc-200 dark:border-zinc-800">
                  <td className="px-3 py-1.5 text-left">{t.entryDate}</td>
                  <td className="px-3 py-1.5">{t.exitDate}</td>
                  <td className="px-3 py-1.5">{t.entryPrice.toFixed(2)}</td>
                  <td className="px-3 py-1.5">{t.exitPrice.toFixed(2)}</td>
                  <td className={`px-3 py-1.5 ${tone(t.returnPct)}`}>{pct(t.returnPct)}</td>
                  <td className="px-3 py-1.5 text-left font-sans">{t.exitReason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
