import { parseCandlesCsv, type ParseResult } from "@/lib/parseCandles";

/** Minimal shape shared with the browser's ImageData, so this file needs no DOM. */
export type PixelImage = { width: number; height: number; data: Uint8ClampedArray };

export type Timeframe = "1d-weekdays" | "1d" | "1w" | "1m";

export const TIMEFRAMES: { value: Timeframe; label: string }[] = [
  { value: "1d-weekdays", label: "Daily (weekdays only)" },
  { value: "1d", label: "Daily (every day)" },
  { value: "1w", label: "Weekly" },
  { value: "1m", label: "Monthly" },
];

export type ExtractOptions = {
  bullColor: string;
  bearColor: string;
  /** Max RGB distance (0-441) for a pixel to count as a candle colour. */
  tolerance: number;
  /** Prices at the top and bottom of the price axis. */
  topPrice: number;
  bottomPrice: number;
  /** Pixel rows (image coordinates) where those prices sit; null = image edge. */
  topRow: number | null;
  bottomRow: number | null;
};

/** Pixel geometry of one candle. `top`/`bottom` are edges, so a 1px line has bottom = top + 1. */
export type DetectedCandle = {
  x0: number;
  x1: number;
  wickTop: number;
  wickBottom: number;
  bodyTop: number;
  bodyBottom: number;
  bullish: boolean;
};

export type Ohlc = { open: number; high: number; low: number; close: number };

export type ExtractResult =
  | { ok: false; error: string }
  | { ok: true; detected: DetectedCandle[]; ohlc: Ohlc[]; decimals: number };

export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

const NONE = 0;
const BULL = 1;
const BEAR = 2;

function median(sorted: number[]): number {
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/**
 * Finds filled candles of two flat colours in a chart image and converts their pixel
 * positions to prices. Assumes a linear price axis and solid (not hollow) bodies, with
 * the wick drawn in the body colour. Candles are returned left to right.
 */
export function extractCandles(img: PixelImage, opt: ExtractOptions): ExtractResult {
  const bull = hexToRgb(opt.bullColor);
  const bear = hexToRgb(opt.bearColor);
  if (!bull || !bear) return { ok: false, error: "Candle colours must be 6-digit hex values like #16a34a." };
  if (!Number.isFinite(opt.topPrice) || !Number.isFinite(opt.bottomPrice)) {
    return { ok: false, error: "Enter the prices at the top and bottom of the axis." };
  }
  if (opt.topPrice <= opt.bottomPrice) return { ok: false, error: "The top price must be higher than the bottom price." };

  const { width, height, data } = img;
  const rowStart = opt.topRow ?? 0;
  const rowEnd = opt.bottomRow ?? height - 1; // inclusive
  if (!Number.isInteger(rowStart) || !Number.isInteger(rowEnd) || rowStart < 0 || rowEnd > height - 1 || rowStart >= rowEnd) {
    return { ok: false, error: `Axis rows must be whole pixel rows within 0-${height - 1}, with top above bottom.` };
  }

  // Pixel-centre convention: a reference row r means the line at y = r + 0.5; image edges are 0 and height.
  const refTopY = opt.topRow === null ? 0 : opt.topRow + 0.5;
  const refBottomY = opt.bottomRow === null ? height : opt.bottomRow + 0.5;
  const toPrice = (y: number) =>
    opt.topPrice + ((y - refTopY) * (opt.bottomPrice - opt.topPrice)) / (refBottomY - refTopY);

  const tol2 = opt.tolerance * opt.tolerance;
  const dist2 = (r: number, g: number, b: number, c: [number, number, number]) =>
    (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;

  // Per column: pixel count and vertical extent for each candle colour.
  const count = [new Int32Array(width), new Int32Array(width), new Int32Array(width)];
  const top = [new Int32Array(width).fill(-1), new Int32Array(width).fill(-1), new Int32Array(width).fill(-1)];
  const bottom = [new Int32Array(width).fill(-1), new Int32Array(width).fill(-1), new Int32Array(width).fill(-1)];

  for (let x = 0; x < width; x++) {
    for (let y = rowStart; y <= rowEnd; y++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 128) continue; // transparent background
      const dBull = dist2(data[i], data[i + 1], data[i + 2], bull);
      const dBear = dist2(data[i], data[i + 1], data[i + 2], bear);
      let k = NONE;
      if (dBull <= tol2 && dBull <= dBear) k = BULL;
      else if (dBear <= tol2) k = BEAR;
      if (k === NONE) continue;
      count[k][x]++;
      if (top[k][x] === -1) top[k][x] = y;
      bottom[k][x] = y;
    }
  }

  const columnKind = (x: number) =>
    count[BULL][x] === 0 && count[BEAR][x] === 0 ? NONE : count[BULL][x] >= count[BEAR][x] ? BULL : BEAR;

  const detected: DetectedCandle[] = [];
  let x = 0;
  while (x < width) {
    const kind = columnKind(x);
    if (kind === NONE) {
      x++;
      continue;
    }
    let end = x;
    while (end + 1 < width && columnKind(end + 1) === kind) end++;

    const tops: number[] = [];
    const bottoms: number[] = [];
    let pixels = 0;
    for (let c = x; c <= end; c++) {
      tops.push(top[kind][c]);
      bottoms.push(bottom[kind][c] + 1);
      pixels += count[kind][c];
    }

    // A run of 1-2 stray pixels is noise (text, anti-aliasing), not a candle.
    if (pixels >= 3) {
      const wickTop = Math.min(...tops);
      const wickBottom = Math.max(...bottoms);
      let bodyTop: number;
      let bodyBottom: number;
      if (tops.length >= 3) {
        // The wick is only 1-2px wide, so most columns show the body alone.
        bodyTop = median([...tops].sort((a, b) => a - b));
        bodyBottom = median([...bottoms].sort((a, b) => a - b));
      } else {
        // Too narrow to tell body from wick: take the shorter column as the body.
        const shorter = tops.length === 2 && bottoms[1] - tops[1] < bottoms[0] - tops[0] ? 1 : 0;
        bodyTop = tops[shorter];
        bodyBottom = bottoms[shorter];
      }
      detected.push({ x0: x, x1: end, wickTop, wickBottom, bodyTop, bodyBottom, bullish: kind === BULL });
    }
    x = end + 1;
  }

  if (detected.length === 0) {
    return { ok: false, error: "No candles found. Check the colours (or raise the tolerance) and the axis rows." };
  }

  // Round to about a tenth of one pixel's worth of price.
  const perPixel = (opt.topPrice - opt.bottomPrice) / (refBottomY - refTopY);
  const decimals = Math.min(8, Math.max(0, Math.ceil(-Math.log10(perPixel)) + 1));
  const round = (v: number) => Number(v.toFixed(decimals));

  const ohlc = detected.map((c): Ohlc => {
    const upper = toPrice(c.bodyTop);
    const lower = toPrice(c.bodyBottom);
    return {
      open: round(c.bullish ? lower : upper),
      close: round(c.bullish ? upper : lower),
      high: round(toPrice(c.wickTop)),
      low: round(toPrice(c.wickBottom)),
    };
  });
  return { ok: true, detected, ohlc, decimals };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The date of candle `index`, counting from `start` (a validated YYYY-MM-DD date). */
function dateAt(start: Date, index: number, tf: Timeframe): Date {
  const d = new Date(start);
  if (tf === "1d") d.setUTCDate(d.getUTCDate() + index);
  else if (tf === "1w") d.setUTCDate(d.getUTCDate() + index * 7);
  else if (tf === "1m") {
    // Clamp so a 31st start doesn't spill into the following month.
    const day = start.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(start.getUTCMonth() + index);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  } else {
    // Weekdays only: step forward, skipping Saturday and Sunday.
    let left = index;
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    while (left > 0) {
      d.setUTCDate(d.getUTCDate() + 1);
      if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) left--;
    }
  }
  return d;
}

/**
 * Dates the rebuilt candles and runs them through the CSV parser, so image candles get
 * exactly the same validation as an uploaded file. Volume is unknown, so it is 0.
 */
export function ohlcToParseResult(ohlc: Ohlc[], startDate: string, tf: Timeframe): ParseResult {
  const start = new Date(`${startDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || Number.isNaN(start.getTime()) || isoDate(start) !== startDate) {
    return { ok: false, fatal: "Enter a valid start date." };
  }
  const rows = ohlc.map(
    (c, i) => `${isoDate(dateAt(start, i, tf))},${c.open},${c.high},${c.low},${c.close},0`,
  );
  return parseCandlesCsv(["date,open,high,low,close,volume", ...rows].join("\n"));
}
