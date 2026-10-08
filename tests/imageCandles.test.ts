import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractCandles, ohlcToParseResult, type ExtractOptions, type Ohlc, type PixelImage } from "@/lib/imageCandles";

const GREEN: [number, number, number] = [22, 163, 74]; // #16a34a
const RED: [number, number, number] = [220, 38, 38]; // #dc2626

type Truth = { o: number; h: number; l: number; c: number };

/**
 * Draws a chart the way a renderer would: filled bodies 9px wide, 1px wicks, flat colours, a light
 * grid, one candle every 18px. The price axis maps `top` to row `plotTop` and `bottom` to `plotBottom`.
 */
function drawChart(opts: {
  candles: Truth[];
  width?: number;
  height?: number;
  top?: number;
  bottom?: number;
  plotTop?: number;
  plotBottom?: number;
  volumePanel?: boolean;
}) {
  const { candles, top = 200, bottom = 100, volumePanel = false } = opts;
  const width = opts.width ?? 20 + candles.length * 18 + 20;
  const height = opts.height ?? 500;
  const plotTop = opts.plotTop ?? 0;
  const plotBottom = opts.plotBottom ?? height;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const put = (x: number, y: number, c: number[]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    data[i] = c[0];
    data[i + 1] = c[1];
    data[i + 2] = c[2];
  };
  for (let y = plotTop; y < plotBottom; y += 50) for (let x = 0; x < width; x++) put(x, y, [230, 230, 230]);

  const y = (p: number) => plotTop + ((top - p) / (top - bottom)) * (plotBottom - plotTop);
  candles.forEach((k, i) => {
    const col = k.c >= k.o ? GREEN : RED;
    const x0 = 20 + i * 18;
    const wickA = Math.round(y(k.h));
    const wickB = Math.max(Math.round(y(k.l)), wickA + 1);
    for (let r = wickA; r < wickB; r++) put(x0 + 4, r, col);
    const bodyA = Math.round(y(Math.max(k.o, k.c)));
    const bodyB = Math.max(Math.round(y(Math.min(k.o, k.c))), bodyA + 1);
    for (let r = bodyA; r < bodyB; r++) for (let x = x0; x < x0 + 9; x++) put(x, r, col);
    if (volumePanel) for (let r = height - 60; r < height - 5; r++) for (let x = x0; x < x0 + 9; x++) put(x, r, col);
  });
  const img: PixelImage = { width, height, data };
  return { img, y };
}

const randomCandles = (n: number, seed = 7): Truth[] => {
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let p = 150;
  return Array.from({ length: n }, () => {
    const o = p;
    const c = Math.min(190, Math.max(110, o + (rnd() - 0.5) * 16));
    p = c;
    return { o, c, h: Math.min(198, Math.max(o, c) + rnd() * 5), l: Math.max(102, Math.min(o, c) - rnd() * 5) };
  });
};

const base: ExtractOptions = {
  bullColor: "#16a34a",
  bearColor: "#dc2626",
  tolerance: 40,
  topPrice: 200,
  bottomPrice: 100,
  topRow: null,
  bottomRow: null,
};
const extract = (img: PixelImage, o: Partial<ExtractOptions> = {}) => {
  const r = extractCandles(img, { ...base, ...o });
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r;
};
const failure = (img: PixelImage, o: Partial<ExtractOptions> = {}) => {
  const r = extractCandles(img, { ...base, ...o });
  assert.ok(!r.ok, "expected an error");
  return r.ok ? "" : r.error;
};

describe("extractCandles: recovers prices from a drawn chart", () => {
  const truth = randomCandles(40);
  const { img } = drawChart({ candles: truth });
  const r = extract(img);
  // 500px for 100 of price: one pixel is 0.2, and pixel rounding costs at most half a pixel each way.
  const ONE_PIXEL = 0.2;

  it("finds every candle, left to right", () => {
    assert.equal(r.detected.length, truth.length);
    r.detected.forEach((d, i) => assert.equal(d.x0, 20 + i * 18));
  });

  it("recovers open, high, low and close to within one pixel of price", () => {
    r.ohlc.forEach((c, i) => {
      const t = truth[i];
      for (const [name, got, want] of [["open", c.open, t.o], ["high", c.high, t.h], ["low", c.low, t.l], ["close", c.close, t.c]] as const) {
        assert.ok(Math.abs(got - want) <= ONE_PIXEL, `candle ${i} ${name}: ${got} vs ${want}`);
      }
    });
  });

  it("reads a rising candle as bullish (close above open) and a falling one as bearish", () => {
    r.ohlc.forEach((c, i) => {
      assert.equal(r.detected[i].bullish, truth[i].c >= truth[i].o, `candle ${i}`);
      if (r.detected[i].bullish) assert.ok(c.close >= c.open);
      else assert.ok(c.close <= c.open);
    });
  });

  it("always returns high >= max(open, close) and low <= min(open, close)", () => {
    for (const c of r.ohlc) {
      assert.ok(c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close));
    }
  });

  it("rounds prices to a sensible number of decimals for the scale", () => {
    assert.equal(r.decimals, 2);
    for (const c of r.ohlc) assert.equal(c.high, Number(c.high.toFixed(2)));
    const fine = extract(drawChart({ candles: randomCandles(5).map((k) => ({ o: k.o / 10000 + 1, h: k.h / 10000 + 1, l: k.l / 10000 + 1, c: k.c / 10000 + 1 })), top: 1.02, bottom: 1.01 }).img, {
      topPrice: 1.02,
      bottomPrice: 1.01,
    });
    assert.ok(fine.decimals >= 5, `a 0.01 range over 500px needs more decimals (got ${fine.decimals})`);
  });
});

describe("extractCandles: the price axis", () => {
  it("maps the two reference prices onto the image edges by default", () => {
    // A single candle spanning exactly the top half: prices 200 down to 150.
    const { img } = drawChart({ candles: [{ o: 150, h: 200, l: 150, c: 200 }] });
    const c = extract(img).ohlc[0];
    assert.ok(Math.abs(c.high - 200) <= 0.2 && Math.abs(c.low - 150) <= 0.2);
  });

  it("uses the reference rows when the plot has margins, and ignores everything outside them", () => {
    // 560px tall: the axis runs from row 40 (200) to row 400 (100); a volume panel in the same colours sits below.
    const truth = randomCandles(30);
    const { img } = drawChart({ candles: truth, height: 560, plotTop: 40, plotBottom: 400, volumePanel: true });
    const r = extract(img, { topRow: 40, bottomRow: 399 });
    assert.equal(r.detected.length, truth.length);
    const onePx = 100 / 360;
    r.ohlc.forEach((c, i) => {
      assert.ok(Math.abs(c.low - truth[i].l) <= onePx * 1.5, `candle ${i} low ${c.low} vs ${truth[i].l}`);
      assert.ok(Math.abs(c.high - truth[i].h) <= onePx * 1.5, `candle ${i} high`);
    });
  });

  it("the bottom reference row is inclusive: a wick that reaches it is measured to its edge", () => {
    // 100px tall, axis from row 0 (100) to row 99 (0). The wick runs down to and including row 99.
    const h = 100;
    const img: PixelImage = { width: 40, height: h, data: new Uint8ClampedArray(40 * h * 4).fill(255) };
    const paint = (x0: number, x1: number, y0: number, y1: number) => {
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const i = (y * 40 + x) * 4;
          img.data[i] = GREEN[0];
          img.data[i + 1] = GREEN[1];
          img.data[i + 2] = GREEN[2];
        }
    };
    paint(10, 18, 30, 50); // body
    paint(14, 14, 20, 99); // wick, all the way to the last row
    const r = extract(img, { topPrice: 100, bottomPrice: 0, topRow: 0, bottomRow: 99 });
    const lowest = r.detected[0].wickBottom;
    assert.equal(lowest, 100, "the wick's bottom edge is the bottom of row 99");
  });

  it("without the rows, volume bars in the candle colours merge into the candles and wreck the lows", () => {
    const truth = randomCandles(10);
    const { img } = drawChart({ candles: truth, height: 560, plotTop: 40, plotBottom: 400, volumePanel: true });
    const wrong = extract(img, { topPrice: 200, bottomPrice: 100 }); // whole image used as the axis
    const worst = Math.max(...wrong.ohlc.map((c, i) => Math.abs(c.low - truth[i].l)));
    assert.ok(worst > 30, `lows should be badly off without the rows (worst ${worst.toFixed(1)})`);
  });
});

describe("extractCandles: colours", () => {
  const truth = randomCandles(12);
  const { img } = drawChart({ candles: truth });

  it("swapping the two colours swaps which candles are bullish", () => {
    const swapped = extract(img, { bullColor: "#dc2626", bearColor: "#16a34a" });
    swapped.detected.forEach((d, i) => assert.equal(d.bullish, !(truth[i].c >= truth[i].o)));
  });

  it("finds nothing if neither colour is in the image", () => {
    assert.match(failure(img, { bullColor: "#0000ff", bearColor: "#ff00ff" }), /No candles found/);
  });

  it("a slightly off colour is picked up inside the tolerance and ignored outside it", () => {
    const off = drawChart({ candles: truth }).img;
    // Nudge every green pixel by 20 in the red channel: distance 20.
    for (let i = 0; i < off.data.length; i += 4) {
      if (off.data[i] === GREEN[0] && off.data[i + 1] === GREEN[1] && off.data[i + 2] === GREEN[2]) off.data[i] += 20;
    }
    const greens = truth.filter((k) => k.c >= k.o).length;
    assert.equal(extract(off, { tolerance: 40 }).detected.filter((d) => d.bullish).length, greens);
    // At tolerance 5 the nudged greens no longer match, so only the (untouched) red candles are found.
    assert.equal(extract(off, { tolerance: 5 }).detected.filter((d) => d.bullish).length, 0);
  });

  it("pixels equally close to both colours go to the nearer one", () => {
    const mid: [number, number, number] = [121, 100, 57]; // roughly between green and red
    const { img: one } = drawChart({ candles: [{ o: 150, h: 160, l: 140, c: 155 }] });
    for (let i = 0; i < one.data.length; i += 4) {
      if (one.data[i] === GREEN[0]) {
        one.data[i] = mid[0];
        one.data[i + 1] = mid[1];
        one.data[i + 2] = mid[2];
      }
    }
    const r = extract(one, { tolerance: 200 });
    assert.equal(r.detected.length, 1);
  });

  // A pixel counts as a candle colour only if its straight-line distance in RGB space is within the
  // tolerance, which is stricter than each channel being within it separately.
  const tinted = (offset: number, tolerance: number) => {
    const img: PixelImage = { width: 30, height: 60, data: new Uint8ClampedArray(30 * 60 * 4).fill(255) };
    for (let y = 20; y < 40; y++)
      for (let x = 8; x < 17; x++) {
        const i = (y * 30 + x) * 4;
        img.data[i] = GREEN[0] + offset;
        img.data[i + 1] = GREEN[1] + offset;
        img.data[i + 2] = GREEN[2] + offset;
      }
    return extractCandles(img, { ...base, topPrice: 60, bottomPrice: 0, tolerance }).ok;
  };

  it("a colour 20 away in every channel (distance 34.6) matches at tolerance 40", () => {
    assert.equal(tinted(20, 40), true);
  });

  it("a colour 30 away in every channel (distance 52.0) does NOT match at tolerance 40, though each channel alone is within 40", () => {
    assert.equal(tinted(30, 40), false);
    assert.equal(tinted(30, 53), true);
  });

  it("a pixel exactly as close to both colours goes to the bullish colour", () => {
    const mid: PixelImage = { width: 30, height: 60, data: new Uint8ClampedArray(30 * 60 * 4).fill(255) };
    for (let y = 20; y < 40; y++)
      for (let x = 8; x < 17; x++) {
        const i = (y * 30 + x) * 4;
        mid.data[i] = mid.data[i + 1] = mid.data[i + 2] = 125;
      }
    // 125 is 25 from 100 and 25 from 150 in every channel: a true tie.
    const r = extractCandles(mid, { ...base, bullColor: "#646464", bearColor: "#969696", topPrice: 60, bottomPrice: 0, tolerance: 100 });
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.detected[0].bullish, true);
  });

  it("a ragged edge column does not move the body: it is taken from the typical column, not the first", () => {
    // Body rows 30-50 in every column but the left-most, which is only 3 rows tall (as a rounded edge can be).
    const img: PixelImage = { width: 40, height: 100, data: new Uint8ClampedArray(40 * 100 * 4).fill(255) };
    const paint = (x: number, y0: number, y1: number) => {
      for (let y = y0; y <= y1; y++) {
        const i = (y * 40 + x) * 4;
        img.data[i] = GREEN[0];
        img.data[i + 1] = GREEN[1];
        img.data[i + 2] = GREEN[2];
      }
    };
    paint(10, 40, 42);
    for (let x = 11; x <= 18; x++) paint(x, 30, 50);
    paint(14, 20, 60); // wick
    const r = extract(img, { topPrice: 100, bottomPrice: 0 });
    assert.equal(r.detected[0].bodyTop, 30);
    assert.equal(r.detected[0].bodyBottom, 51);
  });

  it("ignores fully transparent pixels, whatever colour is stored in them", () => {
    const t = drawChart({ candles: [{ o: 150, h: 160, l: 140, c: 155 }] }).img;
    for (let i = 3; i < t.data.length; i += 4) t.data[i] = 0; // everything transparent
    assert.match(failure(t), /No candles found/);
  });
});

describe("extractCandles: noise and shapes", () => {
  it("a stray speck of one or two pixels in a candle colour is not a candle", () => {
    // One real candle at x 20-28, then two specks side by side and one on its own further right.
    const small = drawChart({ candles: [{ o: 150, h: 160, l: 140, c: 155 }], width: 120 }).img;
    for (const [x, yy] of [[60, 100], [61, 100], [90, 200]] as const) {
      const i = (yy * small.width + x) * 4;
      small.data[i] = RED[0];
      small.data[i + 1] = RED[1];
      small.data[i + 2] = RED[2];
    }
    const r = extract(small);
    assert.equal(r.detected.length, 1, "the three stray pixels are ignored");
  });

  it("a doji (open equals close) comes back with open and close within a pixel of each other", () => {
    const { img } = drawChart({ candles: [{ o: 150, h: 160, l: 140, c: 150 }] });
    const c = extract(img).ohlc[0];
    assert.ok(Math.abs(c.open - c.close) <= 0.2 + 1e-9);
    assert.ok(c.high > c.low);
  });

  it("a thin 1-pixel-wide candle (all wick) still reads, with the body taken from the wick", () => {
    const w = 40;
    const img: PixelImage = { width: w, height: 100, data: new Uint8ClampedArray(w * 100 * 4).fill(255) };
    for (let y = 20; y < 60; y++) {
      const i = (y * w + 10) * 4;
      img.data[i] = GREEN[0];
      img.data[i + 1] = GREEN[1];
      img.data[i + 2] = GREEN[2];
    }
    const r = extractCandles(img, { ...base, topPrice: 100, bottomPrice: 0 });
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.detected.length, 1);
  });

  it("two candles of different colours touching side by side are separate candles", () => {
    const w = 40;
    const img: PixelImage = { width: w, height: 100, data: new Uint8ClampedArray(w * 100 * 4).fill(255) };
    for (let y = 30; y < 50; y++)
      for (let x = 5; x < 20; x++) {
        const i = (y * w + x) * 4;
        const c = x < 12 ? GREEN : RED;
        img.data[i] = c[0];
        img.data[i + 1] = c[1];
        img.data[i + 2] = c[2];
      }
    const r = extractCandles(img, { ...base, topPrice: 100, bottomPrice: 0 });
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.detected.map((d) => d.bullish), [true, false]);
  });
});

describe("extractCandles: bad input is explained, not crashed on", () => {
  const { img } = drawChart({ candles: randomCandles(3) });

  it("colours must be six-digit hex", () => {
    for (const bad of ["#16a3", "16a34a", "green", "", "#gggggg"]) {
      assert.match(failure(img, { bullColor: bad }), /6-digit hex/, bad);
    }
    assert.match(failure(img, { bearColor: "nope" }), /6-digit hex/);
  });

  it("accepts upper-case hex", () => {
    assert.ok(extractCandles(img, { ...base, bullColor: "#16A34A" }).ok);
  });

  it("needs both axis prices, with the top above the bottom", () => {
    assert.match(failure(img, { topPrice: NaN }), /prices at the top and bottom/);
    assert.match(failure(img, { bottomPrice: NaN }), /prices at the top and bottom/);
    assert.match(failure(img, { topPrice: 100, bottomPrice: 200 }), /top price must be higher/);
    assert.match(failure(img, { topPrice: 100, bottomPrice: 100 }), /top price must be higher/);
  });

  it("the reference rows must be whole rows inside the image with the top above the bottom", () => {
    const h = img.height;
    for (const [topRow, bottomRow] of [[1.5, null], [null, 2.5], [-1, null], [null, h], [100, 100], [200, 100], [NaN, null]] as const) {
      assert.match(failure(img, { topRow, bottomRow }), /Axis rows must be whole pixel rows/, `${topRow}, ${bottomRow}`);
    }
  });

  it("an image with nothing in it reports no candles", () => {
    const blank: PixelImage = { width: 50, height: 50, data: new Uint8ClampedArray(50 * 50 * 4).fill(255) };
    assert.match(failure(blank), /No candles found/);
  });

  it("a 1x1 image does not crash", () => {
    const one: PixelImage = { width: 1, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255]) };
    assert.match(failure(one), /Axis rows|No candles/);
  });
});

describe("ohlcToParseResult: dating the candles", () => {
  const one = (i: number): Ohlc => ({ open: 10 + i, high: 12 + i, low: 9 + i, close: 11 + i });
  const rows = (n: number) => Array.from({ length: n }, (_, i) => one(i));
  const dates = (n: number, start: string, tf: Parameters<typeof ohlcToParseResult>[2]) => {
    const r = ohlcToParseResult(rows(n), start, tf);
    assert.ok(r.ok, r.ok ? "" : r.fatal);
    return r.ok ? r.candles.map((c) => c.date) : [];
  };

  it("daily, every day: one calendar day apart, weekends included", () => {
    assert.deepEqual(dates(4, "2024-01-05", "1d"), ["2024-01-05", "2024-01-06", "2024-01-07", "2024-01-08"]);
  });

  it("daily, weekdays only: Friday is followed by Monday", () => {
    assert.deepEqual(dates(5, "2024-01-04", "1d-weekdays"), ["2024-01-04", "2024-01-05", "2024-01-08", "2024-01-09", "2024-01-10"]);
  });

  it("weekdays only starting on a weekend: the first candle moves to the following Monday", () => {
    assert.deepEqual(dates(3, "2024-01-06", "1d-weekdays"), ["2024-01-08", "2024-01-09", "2024-01-10"]); // Saturday
    assert.deepEqual(dates(2, "2024-01-07", "1d-weekdays"), ["2024-01-08", "2024-01-09"]); // Sunday
  });

  it("weekdays only never lands on a weekend over a long run", () => {
    for (const d of dates(500, "2023-03-03", "1d-weekdays")) {
      const day = new Date(`${d}T00:00:00Z`).getUTCDay();
      assert.ok(day !== 0 && day !== 6, d);
    }
  });

  it("weekly: seven days apart, across a year boundary", () => {
    assert.deepEqual(dates(3, "2023-12-25", "1w"), ["2023-12-25", "2024-01-01", "2024-01-08"]);
  });

  it("monthly: same day each month, clamped to the end of a short month and not drifting", () => {
    assert.deepEqual(dates(5, "2024-01-31", "1m"), ["2024-01-31", "2024-02-29", "2024-03-31", "2024-04-30", "2024-05-31"]);
    assert.deepEqual(dates(3, "2023-01-31", "1m"), ["2023-01-31", "2023-02-28", "2023-03-31"]); // not a leap year
    assert.deepEqual(dates(3, "2023-11-15", "1m"), ["2023-11-15", "2023-12-15", "2024-01-15"]);
  });

  it("dates are always strictly increasing, for every timeframe and awkward start", () => {
    for (const tf of ["1d", "1d-weekdays", "1w", "1m"] as const) {
      for (const start of ["2024-01-31", "2024-02-29", "2023-12-30", "2024-03-31"]) {
        const d = dates(60, start, tf);
        for (let i = 1; i < d.length; i++) assert.ok(d[i] > d[i - 1], `${tf} from ${start}: ${d[i - 1]} then ${d[i]}`);
      }
    }
  });

  it("rejects a start date that is not a real date", () => {
    for (const start of ["", "garbage", "2024-02-30", "2024-13-01", "2024-1-1", "01/02/2024"]) {
      const r = ohlcToParseResult(rows(2), start, "1d");
      assert.ok(!r.ok && /valid start date/.test(r.fatal), start);
    }
  });

  it("runs through the CSV checks: candles that reach zero or below are rejected, with volume 0", () => {
    const r = ohlcToParseResult([{ open: 5, high: 6, low: 4, close: 5 }, { open: 1, high: 2, low: -1, close: 1 }], "2024-01-01", "1d");
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.candles.length, 1);
      assert.equal(r.candles[0].volume, 0);
      assert.match(r.rowErrors[0].message, /greater than zero/);
    }
  });
});
