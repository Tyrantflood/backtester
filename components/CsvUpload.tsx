"use client";

import { useRef, useState } from "react";
import { parseCandlesCsv, type Candle, type ParseResult } from "@/lib/parseCandles";

const PREVIEW_ROWS = 10;
const MAX_BYTES = 20 * 1024 * 1024;

type Loaded = { fileName: string; result: ParseResult };

export default function CsvUpload({ onLoad }: { onLoad?: (candles: Candle[]) => void }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    const result: ParseResult =
      file.size > MAX_BYTES
        ? { ok: false, fatal: "File is larger than 20 MB." }
        : parseCandlesCsv(await file.text());
    setLoaded({ fileName: file.name, result });
    onLoad?.(result.ok ? result.candles : []);
  }

  const result = loaded?.result;
  const fileName = loaded?.fileName;

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
          dragging
            ? "border-blue-500 bg-blue-50 dark:bg-blue-950"
            : "border-zinc-300 dark:border-zinc-700"
        }`}
      >
        <p className="text-zinc-700 dark:text-zinc-300">Drag a CSV here, or</p>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background hover:opacity-80"
        >
          Choose file
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            e.target.value = "";
          }}
        />
        <p className="text-xs text-zinc-500">
          Required columns: date (YYYY-MM-DD), open, high, low, close, volume
        </p>
      </div>

      {result && !result.ok && (
        <div
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          <strong>Could not load {fileName}.</strong> {result.fatal}
        </div>
      )}

      {result?.ok && (
        <>
          <p className="text-sm text-zinc-700 dark:text-zinc-300">
            <strong>{fileName}</strong>: {result.candles.length} valid candles
            {result.rowErrors.length > 0 &&
              `, ${result.totalRows - result.candles.length} rows rejected`}
            . Sorted by date, {result.candles[0].date} to{" "}
            {result.candles[result.candles.length - 1].date}.
          </p>

          {result.rowErrors.length > 0 && (
            <div
              role="alert"
              className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
            >
              <p className="mb-2 font-medium">Rejected rows (not loaded):</p>
              <ul className="max-h-48 list-disc space-y-1 overflow-y-auto pl-5">
                {result.rowErrors.map((e, i) => (
                  <li key={i}>
                    {e.line > 0 ? `Line ${e.line}: ` : ""}
                    {e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-right font-mono text-sm">
              <caption className="p-2 text-left font-sans text-xs text-zinc-500">
                Preview: first {Math.min(PREVIEW_ROWS, result.candles.length)} of{" "}
                {result.candles.length} rows
              </caption>
              <thead className="bg-zinc-100 font-sans dark:bg-zinc-900">
                <tr>
                  {["date", "open", "high", "low", "close", "volume"].map((h) => (
                    <th key={h} className="px-3 py-2 font-medium first:text-left">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.candles.slice(0, PREVIEW_ROWS).map((c) => (
                  <tr key={c.date} className="border-t border-zinc-200 dark:border-zinc-800">
                    <td className="px-3 py-1.5 text-left">{c.date}</td>
                    <td className="px-3 py-1.5">{c.open}</td>
                    <td className="px-3 py-1.5">{c.high}</td>
                    <td className="px-3 py-1.5">{c.low}</td>
                    <td className="px-3 py-1.5">{c.close}</td>
                    <td className="px-3 py-1.5">{c.volume.toLocaleString("en-US")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
