import { ImageResponse } from "next/og";

export const alt = "Backtester: test trading strategies on your own price data";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BARS = [
  { h: 120, up: false },
  { h: 180, up: true },
  { h: 150, up: true },
  { h: 230, up: true },
  { h: 190, up: false },
  { h: 260, up: true },
  { h: 320, up: true },
];

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          background: "#0a0a0a",
          color: "#ededed",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-end", gap: 18, height: 340 }}>
          {BARS.map((b, i) => (
            <div
              key={i}
              style={{
                width: 44,
                height: b.h,
                borderRadius: 6,
                background: b.up ? "#22c55e" : "#ef4444",
              }}
            />
          ))}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 96, fontWeight: 700 }}>Backtester</div>
          <div style={{ fontSize: 38, color: "#a1a1aa" }}>
            Test trading strategies on your own price data before risking money.
          </div>
        </div>
      </div>
    ),
    size,
  );
}
