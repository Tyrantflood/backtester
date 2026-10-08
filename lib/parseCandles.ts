export type Candle = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type RowError = { line: number; message: string };

export type ParseResult =
  | { ok: false; fatal: string }
  | { ok: true; candles: Candle[]; rowErrors: RowError[]; totalRows: number };

const COLUMNS = ["date", "open", "high", "low", "close", "volume"] as const;
const NUMERIC = ["open", "high", "low", "close", "volume"] as const;
const MAX_ROW_ERRORS = 200;

function splitLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function parseCandlesCsv(text: string): ParseResult {
  const lines = text.replace(/^﻿/, "").split(/\r\n|\n|\r/);
  const headerIdx = lines.findIndex((l) => l.trim() !== "");
  if (headerIdx === -1) return { ok: false, fatal: "The file is empty." };

  const header = splitLine(lines[headerIdx]).map((h) => h.toLowerCase());
  const missing = COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    return {
      ok: false,
      fatal: `Missing required column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. Expected header: ${COLUMNS.join(",")}. Found: ${header.join(",")}.`,
    };
  }
  const dupCol = COLUMNS.find((c) => header.indexOf(c) !== header.lastIndexOf(c));
  if (dupCol) return { ok: false, fatal: `Column "${dupCol}" appears more than once in the header.` };

  const idx = Object.fromEntries(COLUMNS.map((c) => [c, header.indexOf(c)])) as Record<
    (typeof COLUMNS)[number],
    number
  >;

  const candles: Candle[] = [];
  const rowErrors: RowError[] = [];
  const seen = new Map<string, number>();
  let totalRows = 0;
  let droppedErrors = 0;

  const fail = (line: number, message: string) => {
    if (rowErrors.length < MAX_ROW_ERRORS) rowErrors.push({ line, message });
    else droppedErrors++;
  };

  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    const line = i + 1;
    totalRows++;
    const cells = splitLine(lines[i]);

    if (cells.length !== header.length) {
      fail(line, `Expected ${header.length} columns but found ${cells.length}.`);
      continue;
    }

    const date = cells[idx.date];
    if (!isValidDate(date)) {
      fail(line, `Invalid date "${date}". Use YYYY-MM-DD.`);
      continue;
    }

    const nums = {} as Record<(typeof NUMERIC)[number], number>;
    let bad: string | null = null;
    for (const c of NUMERIC) {
      const raw = cells[idx[c]];
      const v = raw === "" ? NaN : Number(raw);
      if (!Number.isFinite(v)) {
        bad = `"${raw}" is not a valid number for ${c}.`;
        break;
      }
      nums[c] = v;
    }
    if (bad) {
      fail(line, bad);
      continue;
    }

    const { open, high, low, close, volume } = nums;
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0) {
      fail(line, "Prices must be greater than zero.");
      continue;
    }
    if (volume < 0) {
      fail(line, "Volume cannot be negative.");
      continue;
    }
    if (high < Math.max(open, close, low)) {
      fail(line, `High (${high}) is below the open, close or low.`);
      continue;
    }
    if (low > Math.min(open, close, high)) {
      fail(line, `Low (${low}) is above the open, close or high.`);
      continue;
    }
    const prev = seen.get(date);
    if (prev !== undefined) {
      fail(line, `Duplicate date ${date} (first seen on line ${prev}).`);
      continue;
    }
    seen.set(date, line);
    candles.push({ date, open, high, low, close, volume });
  }

  if (droppedErrors > 0) {
    rowErrors.push({ line: 0, message: `…and ${droppedErrors} more bad rows not shown.` });
  }
  if (totalRows === 0) return { ok: false, fatal: "The file has a header but no data rows." };
  if (candles.length === 0) {
    return {
      ok: false,
      fatal: `No valid rows. All ${totalRows} rows were rejected. First problem: line ${rowErrors[0].line}: ${rowErrors[0].message}`,
    };
  }

  candles.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { ok: true, candles, rowErrors, totalRows };
}
