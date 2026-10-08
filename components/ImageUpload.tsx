"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import CandleChart from "@/components/CandleChart";
import {
  TIMEFRAMES,
  extractCandles,
  ohlcToParseResult,
  type PixelImage,
  type Timeframe,
} from "@/lib/imageCandles";
import type { Candle } from "@/lib/parseCandles";

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 25_000_000;
const NO_TRADES: never[] = []; // stable identity so the chart isn't rebuilt on every render

const PRESETS = [
  { label: "This app (green / red)", bull: "#16a34a", bear: "#dc2626" },
  { label: "TradingView default", bull: "#26a69a", bear: "#ef5350" },
];

type Picking = "bull" | "bear" | "top" | "bottom" | null;

const INPUT = "rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700";
const LABEL = "flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400";

const toHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

function Field({
  label,
  value,
  onChange,
  placeholder,
  width = "w-28",
  type = "number",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  width?: string;
  type?: string;
}) {
  return (
    <label className={LABEL}>
      {label}
      <input
        type={type}
        className={`${INPUT} ${width}`}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const valid = /^#[0-9a-f]{6}$/i.test(value);
  return (
    <label className={LABEL}>
      {label}
      <span className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} picker`}
          value={valid ? value : "#000000"}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-9 cursor-pointer rounded border border-zinc-300 bg-transparent p-0.5 dark:border-zinc-700"
        />
        <input
          type="text"
          className={`${INPUT} w-24 font-mono`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={!valid}
        />
      </span>
    </label>
  );
}

export default function ImageUpload({ onLoad }: { onLoad: (candles: Candle[]) => void }) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [image, setImage] = useState<PixelImage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const [bull, setBull] = useState(PRESETS[0].bull);
  const [bear, setBear] = useState(PRESETS[0].bear);
  const [tolerance, setTolerance] = useState(40);
  const [topPrice, setTopPrice] = useState("");
  const [bottomPrice, setBottomPrice] = useState("");
  const [topRow, setTopRow] = useState("");
  const [bottomRow, setBottomRow] = useState("");
  const [startDate, setStartDate] = useState("2024-01-01");
  const [timeframe, setTimeframe] = useState<Timeframe>("1d-weekdays");

  const [picking, setPicking] = useState<Picking>(null);
  const [showDetections, setShowDetections] = useState(true);
  const [used, setUsed] = useState<Candle[] | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  async function handleFile(file: File) {
    setLoadError(null);
    setUsed(null);
    if (file.type !== "image/png") return setLoadError("Please choose a PNG image.");
    if (file.size > MAX_BYTES) return setLoadError("Image is larger than 20 MB.");
    try {
      const bitmap = await createImageBitmap(file);
      if (bitmap.width * bitmap.height > MAX_PIXELS) {
        bitmap.close();
        return setLoadError("Image is too large (over 25 megapixels).");
      }
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      setImage(ctx.getImageData(0, 0, canvas.width, canvas.height));
      setFileName(file.name);
      setTopRow("");
      setBottomRow("");
    } catch {
      setLoadError("Could not read that file as an image.");
    }
  }

  const num = (s: string) => (s.trim() === "" ? NaN : Number(s));
  const row = (s: string) => (s.trim() === "" ? null : Number(s));

  const extraction = useMemo(() => {
    if (!image) return null;
    return extractCandles(image, {
      bullColor: bull,
      bearColor: bear,
      tolerance,
      topPrice: num(topPrice),
      bottomPrice: num(bottomPrice),
      topRow: row(topRow),
      bottomRow: row(bottomRow),
    });
  }, [image, bull, bear, tolerance, topPrice, bottomPrice, topRow, bottomRow]);

  const parsed = useMemo(
    () => (extraction?.ok ? ohlcToParseResult(extraction.ohlc, startDate, timeframe) : null),
    [extraction, startDate, timeframe],
  );
  const candles = parsed?.ok ? parsed.candles : null;

  // Draw the original, with reference rows and detected candles on top.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d")!;
    ctx.putImageData(image as ImageData, 0, 0);

    const lw = Math.max(1, image.width / 800);
    ctx.lineWidth = lw;
    ctx.setLineDash([6 * lw, 4 * lw]);
    ctx.strokeStyle = "#0ea5e9";
    for (const r of [row(topRow), row(bottomRow)]) {
      if (r === null || !Number.isFinite(r)) continue;
      ctx.beginPath();
      ctx.moveTo(0, r + 0.5);
      ctx.lineTo(image.width, r + 0.5);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    if (showDetections && extraction?.ok) {
      for (const c of extraction.detected) {
        ctx.strokeStyle = "#f59e0b";
        ctx.strokeRect(c.x0 - 1, c.wickTop - 1, c.x1 - c.x0 + 3, c.wickBottom - c.wickTop + 2);
      }
    }
  }, [image, extraction, showDetections, topRow, bottomRow]);

  function handleCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!picking || !image) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.min(image.width - 1, Math.max(0, Math.floor(((e.clientX - rect.left) * image.width) / rect.width)));
    const y = Math.min(image.height - 1, Math.max(0, Math.floor(((e.clientY - rect.top) * image.height) / rect.height)));
    if (picking === "top") setTopRow(String(y));
    else if (picking === "bottom") setBottomRow(String(y));
    else {
      const i = (y * image.width + x) * 4;
      const hex = toHex(image.data[i], image.data[i + 1], image.data[i + 2]);
      if (picking === "bull") setBull(hex);
      else setBear(hex);
    }
    setPicking(null);
  }

  const pickButton = (kind: Exclude<Picking, null>, label: string) => (
    <button
      type="button"
      onClick={() => setPicking(picking === kind ? null : kind)}
      className={`rounded-full border px-3 py-1 text-xs ${
        picking === kind
          ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-200"
          : "border-zinc-300 dark:border-zinc-700"
      }`}
    >
      {label}
    </button>
  );

  return (
    <section className="w-full space-y-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files[0];
          if (f) void handleFile(f);
        }}
        className={`flex flex-col items-center gap-3 rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
          dragging ? "border-blue-500 bg-blue-50 dark:bg-blue-950" : "border-zinc-300 dark:border-zinc-700"
        }`}
      >
        <p className="text-zinc-700 dark:text-zinc-300">Drag a chart screenshot (PNG) here, or</p>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background hover:opacity-80"
        >
          Choose image
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/png"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            e.target.value = "";
          }}
        />
        <p className="max-w-xl text-xs text-zinc-500">
          Works best on a clean, linear-scale chart with solid two-colour candles. Hollow candles, log scales and
          overlapping indicators in the candle colours will not read correctly.
        </p>
      </div>

      {loadError && (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {loadError}
        </p>
      )}

      {image && (
        <>
          <p className="text-sm text-zinc-700 dark:text-zinc-300">
            <strong>{fileName}</strong>: {image.width} × {image.height}px
          </p>

          <div className="space-y-4 rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
            <h2 className="text-sm font-semibold">Read the image</h2>

            <div className="flex flex-wrap items-end gap-4">
              <label className={LABEL}>
                Colour preset
                <select
                  className={`${INPUT} w-48`}
                  value=""
                  onChange={(e) => {
                    const p = PRESETS[Number(e.target.value)];
                    if (p) {
                      setBull(p.bull);
                      setBear(p.bear);
                    }
                  }}
                >
                  <option value="">Custom</option>
                  {PRESETS.map((p, i) => (
                    <option key={p.label} value={i}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <ColorField label="Bullish (up) colour" value={bull} onChange={setBull} />
              <ColorField label="Bearish (down) colour" value={bear} onChange={setBear} />
              <label className={LABEL}>
                Colour tolerance ({tolerance})
                <input
                  type="range"
                  min={0}
                  max={120}
                  value={tolerance}
                  onChange={(e) => setTolerance(Number(e.target.value))}
                  className="w-36"
                />
              </label>
            </div>

            <div className="flex flex-wrap items-end gap-4">
              <Field label="Price at top of axis" value={topPrice} onChange={setTopPrice} placeholder="e.g. 200" />
              <Field label="Price at bottom of axis" value={bottomPrice} onChange={setBottomPrice} placeholder="e.g. 100" />
              <Field label="Top row (px)" value={topRow} onChange={setTopRow} placeholder="image top" width="w-24" />
              <Field label="Bottom row (px)" value={bottomRow} onChange={setBottomRow} placeholder="image bottom" width="w-24" />
            </div>
            <p className="text-xs text-zinc-500">
              The two prices are the values at the top and bottom of the price axis. If the screenshot has margins or a
              volume panel, set the rows to where those two prices sit (pixels from the top of the image); candles outside
              them are ignored. Left empty, the image edges are used.
            </p>

            <div className="flex flex-wrap items-end gap-4">
              <Field label="First candle date" value={startDate} onChange={setStartDate} type="date" width="w-40" />
              <label className={LABEL}>
                Timeframe
                <select
                  className={`${INPUT} w-48`}
                  value={timeframe}
                  onChange={(e) => setTimeframe(e.target.value as Timeframe)}
                >
                  {TIMEFRAMES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-zinc-500">Pick from the image:</span>
              {pickButton("bull", "Bullish colour")}
              {pickButton("bear", "Bearish colour")}
              {pickButton("top", "Top row")}
              {pickButton("bottom", "Bottom row")}
              <label className="ml-auto flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
                <input
                  type="checkbox"
                  checked={showDetections}
                  onChange={(e) => setShowDetections(e.target.checked)}
                />
                Outline detected candles
              </label>
            </div>
            {picking && (
              <p className="text-xs text-blue-700 dark:text-blue-300">
                Click the image to set the{" "}
                {{ bull: "bullish colour", bear: "bearish colour", top: "top row", bottom: "bottom row" }[picking]}.
              </p>
            )}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <figure className="space-y-1">
              <figcaption className="text-xs text-zinc-500">Original</figcaption>
              <div className="h-[420px] overflow-auto rounded-md border border-zinc-200 dark:border-zinc-800">
                <canvas
                  ref={canvasRef}
                  onClick={handleCanvasClick}
                  className={`block w-full ${picking ? "cursor-crosshair" : ""}`}
                  aria-label="Uploaded chart image"
                />
              </div>
            </figure>
            <figure className="space-y-1">
              <figcaption className="text-xs text-zinc-500">
                Rebuilt{candles ? ` (${candles.length} candles)` : ""}
              </figcaption>
              {candles ? (
                <CandleChart candles={candles} trades={NO_TRADES} />
              ) : (
                <div className="flex h-[420px] items-center justify-center rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
                  {extraction && !extraction.ok
                    ? extraction.error
                    : parsed && !parsed.ok
                      ? parsed.fatal
                      : "The rebuilt chart appears here."}
                </div>
              )}
            </figure>
          </div>

          {parsed?.ok && parsed.rowErrors.length > 0 && (
            <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
              <p className="mb-2 font-medium">
                {parsed.totalRows - parsed.candles.length} detected candles were rejected (usually a price axis that
                reaches zero or below):
              </p>
              <ul className="max-h-32 list-disc space-y-1 overflow-y-auto pl-5">
                {parsed.rowErrors.map((e, i) => (
                  <li key={i}>{e.message}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-4">
            <button
              type="button"
              disabled={!candles}
              onClick={() => {
                if (!candles) return;
                onLoad(candles);
                setUsed(candles);
              }}
              className="rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background hover:opacity-80 disabled:opacity-40"
            >
              Use these candles
            </button>
            {used !== null && used === candles && (
              <p className="text-sm text-zinc-700 dark:text-zinc-300">
                Loaded {used.length} candles. Volume is not in an image, so it is set to 0.
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
