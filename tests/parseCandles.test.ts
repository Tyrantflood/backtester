import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCandlesCsv } from "@/lib/parseCandles";

const HEADER = "date,open,high,low,close,volume";
const ok = (text: string) => {
  const r = parseCandlesCsv(text);
  assert.ok(r.ok, r.ok ? "" : r.fatal);
  return r;
};
const bad = (text: string) => {
  const r = parseCandlesCsv(text);
  assert.ok(!r.ok, "expected a fatal error");
  return r.ok ? "" : r.fatal;
};

describe("parseCandlesCsv: a good file", () => {
  it("reads rows into candles", () => {
    const r = ok(`${HEADER}\n2024-01-02,10,12,9,11,1000\n2024-01-03,11,13,10,12,2000`);
    assert.deepEqual(r.candles, [
      { date: "2024-01-02", open: 10, high: 12, low: 9, close: 11, volume: 1000 },
      { date: "2024-01-03", open: 11, high: 13, low: 10, close: 12, volume: 2000 },
    ]);
    assert.equal(r.totalRows, 2);
    assert.deepEqual(r.rowErrors, []);
  });

  it("sorts rows into date order", () => {
    const r = ok(`${HEADER}\n2024-01-05,1,2,1,1,0\n2024-01-02,1,2,1,1,0\n2024-01-03,1,2,1,1,0`);
    assert.deepEqual(r.candles.map((c) => c.date), ["2024-01-02", "2024-01-03", "2024-01-05"]);
  });

  it("accepts any header case, any column order, and ignores spaces around values", () => {
    const r = ok(`Volume, CLOSE ,low,High,open,Date\n 500 , 11 , 9 , 12 , 10 , 2024-01-02 `);
    assert.deepEqual(r.candles[0], { date: "2024-01-02", open: 10, high: 12, low: 9, close: 11, volume: 500 });
  });

  it("copes with a byte-order mark, and with Windows, Mac and Unix line endings", () => {
    for (const eol of ["\n", "\r\n", "\r"]) {
      const r = ok(`﻿${HEADER}${eol}2024-01-02,1,2,1,1,5${eol}2024-01-03,1,2,1,1,6${eol}`);
      assert.equal(r.candles.length, 2, JSON.stringify(eol));
    }
  });

  it("skips blank lines, including whitespace-only ones, before and between rows", () => {
    const r = ok(`\n\n${HEADER}\n\n2024-01-02,1,2,1,1,5\n   \n2024-01-03,1,2,1,1,6\n\n`);
    assert.equal(r.candles.length, 2);
    assert.equal(r.totalRows, 2);
  });

  it("reads quoted values, including a doubled quote inside one", () => {
    const r = ok(`"date","open","high","low","close","volume"\n"2024-01-02","10","12","9","11","1000"`);
    assert.equal(r.candles[0].close, 11);
  });

  it("accepts scientific notation, decimals without a leading digit, and a zero volume", () => {
    const r = ok(`${HEADER}\n2024-01-02,1e1,.5e2,5.,2.5E1,0`);
    assert.deepEqual(r.candles[0], { date: "2024-01-02", open: 10, high: 50, low: 5, close: 25, volume: 0 });
  });

  it("allows a flat candle where open, high, low and close are all equal", () => {
    assert.equal(ok(`${HEADER}\n2024-01-02,5,5,5,5,1`).candles.length, 1);
  });
});

describe("parseCandlesCsv: a bad file", () => {
  it("rejects an empty file and a whitespace-only one", () => {
    assert.match(bad(""), /empty/i);
    assert.match(bad("  \n \r\n\t\n"), /empty/i);
  });

  it("names every missing column and shows what it found", () => {
    const msg = bad("date,open,close\n2024-01-02,1,1");
    assert.match(msg, /Missing required columns: high, low, volume/);
    assert.match(msg, /Found: date,open,close/);
  });

  it("says 'column' in the singular for a single missing one", () => {
    assert.match(bad("date,open,high,low,close\n2024-01-02,1,2,1,1"), /Missing required column: volume/);
  });

  it("rejects a repeated column", () => {
    assert.match(bad(`${HEADER},close\n2024-01-02,1,2,1,1,5,1`), /"close" appears more than once/);
  });

  it("rejects a file with a header but no rows", () => {
    assert.match(bad(HEADER), /no data rows/i);
    assert.match(bad(`${HEADER}\n\n  \n`), /no data rows/i);
  });

  it("a semicolon-separated file is reported as missing columns, not silently misread", () => {
    assert.match(bad("date;open;high;low;close;volume\n2024-01-02;1;2;1;1;5"), /Missing required columns/);
  });

  it("when every row is bad, reports the first problem with its line number", () => {
    const msg = bad(`${HEADER}\n2024-01-02,abc,2,1,1,5\n2024-01-03,1,2,1,1,x`);
    assert.match(msg, /All 2 rows were rejected/);
    assert.match(msg, /line 2: "abc" is not a valid number for open/);
  });
});

describe("parseCandlesCsv: rejected rows", () => {
  const rejected = (row: string) => {
    const r = ok(`${HEADER}\n2024-01-01,1,2,1,1,5\n${row}`);
    assert.equal(r.candles.length, 1, `row should have been rejected: ${row}`);
    assert.equal(r.rowErrors.length, 1);
    return r.rowErrors[0];
  };

  it("wrong number of columns, with the line number", () => {
    const e = rejected("2024-01-02,1,2,1,1");
    assert.equal(e.line, 3);
    assert.match(e.message, /Expected 6 columns but found 5/);
    assert.match(rejected("2024-01-02,1,2,1,1,5,9").message, /found 7/);
  });

  it("dates that are not real YYYY-MM-DD dates", () => {
    for (const d of ["2024-02-30", "2024-13-01", "2024-1-2", "02/01/2024", "2024-01-02T00:00:00Z", "2024-01-02 09:30", "", "yesterday"]) {
      assert.match(rejected(`${d},1,2,1,1,5`).message, /Invalid date/, d);
    }
  });

  it("accepts the leap day only in a leap year", () => {
    assert.equal(ok(`${HEADER}\n2024-02-29,1,2,1,1,5`).candles.length, 1);
    assert.match(rejected("2023-02-29,1,2,1,1,5").message, /Invalid date/);
  });

  it("values that are not finite numbers", () => {
    for (const v of ["abc", "", " ", "NaN", "Infinity", "-Infinity", "1e999"]) {
      assert.match(rejected(`2024-01-02,${v},2,1,1,5`).message, /not a valid number for open/, JSON.stringify(v));
    }
  });

  it("zero or negative prices, but a zero volume is fine", () => {
    for (const row of ["2024-01-02,0,2,1,1,5", "2024-01-02,1,2,-1,1,5", "2024-01-02,1,-2,1,1,5", "2024-01-02,1,2,1,0,5"]) {
      assert.match(rejected(row).message, /greater than zero/, row);
    }
    assert.equal(ok(`${HEADER}\n2024-01-02,1,2,1,1,0`).candles.length, 1);
  });

  it("a negative volume", () => {
    assert.match(rejected("2024-01-02,1,2,1,1,-5").message, /Volume cannot be negative/);
  });

  it("a high below the open, close or low", () => {
    assert.match(rejected("2024-01-02,5,4,1,3,5").message, /High \(4\) is below/); // below the open
    assert.match(rejected("2024-01-02,1,2,1,3,5").message, /High \(2\) is below/); // below the close
    assert.match(rejected("2024-01-02,1,1,2,1,5").message, /High \(1\) is below/); // below the low
  });

  it("a low above the open, close or high", () => {
    assert.match(rejected("2024-01-02,1,5,3,4,5").message, /Low \(3\) is above/); // above the open
    assert.match(rejected("2024-01-02,4,5,3,2,5").message, /Low \(3\) is above/); // above the close
  });

  it("a repeated date keeps the first and points to its line", () => {
    const r = ok(`${HEADER}\n2024-01-02,1,2,1,1,5\n2024-01-03,1,2,1,1,5\n2024-01-02,9,9,9,9,9`);
    assert.deepEqual(r.candles.map((c) => c.open), [1, 1]);
    assert.match(r.rowErrors[0].message, /Duplicate date 2024-01-02 \(first seen on line 2\)/);
    assert.equal(r.rowErrors[0].line, 4);
  });

  it("line numbers count blank lines and the header", () => {
    const r = ok(`\n${HEADER}\n\n2024-01-02,1,2,1,1,5\n\n2024-01-03,abc,2,1,1,5`);
    assert.equal(r.rowErrors[0].line, 6);
  });

  it("keeps the good rows and reports how many were rejected", () => {
    const r = ok(`${HEADER}\n2024-01-02,1,2,1,1,5\nbad\n2024-01-04,1,2,1,1,5\n2024-01-05,x,2,1,1,5`);
    assert.equal(r.candles.length, 2);
    assert.equal(r.totalRows, 4);
    assert.equal(r.rowErrors.length, 2);
  });

  it("caps the list of row errors at 200 and says how many more there were", () => {
    const rows = Array.from({ length: 250 }, (_, i) => `2024-01-01,bad${i},2,1,1,5`);
    const r = ok([HEADER, "2024-01-02,1,2,1,1,5", ...rows].join("\n"));
    assert.equal(r.candles.length, 1);
    assert.equal(r.rowErrors.length, 201); // 200 shown plus the summary line
    assert.match(r.rowErrors[200].message, /and 50 more bad rows/);
  });
});
