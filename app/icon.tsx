import { ImageResponse } from "next/og";

export const size = { width: 64, height: 64 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          background: "#0a0a0a",
          borderRadius: 14,
        }}
      >
        <div style={{ width: 10, height: 28, background: "#ef4444", borderRadius: 2 }} />
        <div style={{ width: 10, height: 44, background: "#22c55e", borderRadius: 2 }} />
        <div style={{ width: 10, height: 34, background: "#22c55e", borderRadius: 2 }} />
        <div style={{ width: 10, height: 50, background: "#22c55e", borderRadius: 2 }} />
      </div>
    ),
    size,
  );
}
