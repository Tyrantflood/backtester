import type { Trade } from "@/lib/backtest";

/**
 * The trades worth drawing for a window of candles, from candle index `from` to `to` (either may
 * be fractional, or infinite for "everything").
 *
 * Trades come in time order and never overlap, so both their entry and exit indices only ever
 * increase, which lets two binary searches find the window without scanning every trade. If more
 * than `max` trades fall in the window only the most recent `max` are returned: markers that
 * dense cannot be read, and drawing tens of thousands of them makes the chart crawl.
 */
export function tradesInRange(trades: Trade[], from: number, to: number, max: number): Trade[] {
  // First trade that has not ended before the window starts.
  let lo = 0;
  let hi = trades.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (trades[mid].exitIndex < from) lo = mid + 1;
    else hi = mid;
  }
  const start = lo;

  // First trade that begins after the window ends.
  hi = trades.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (trades[mid].entryIndex <= to) lo = mid + 1;
    else hi = mid;
  }
  const end = lo;

  return trades.slice(Math.max(start, end - max), end);
}
