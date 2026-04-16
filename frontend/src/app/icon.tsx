import { ImageResponse } from "next/og";

const size = { width: 512, height: 512 };

export const contentType = "image/png";

export default function Icon(): ImageResponse {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background:
            "linear-gradient(135deg, #0f172a 0%, #1d4ed8 45%, #60a5fa 100%)",
          color: "#fff",
          fontFamily: "sans-serif",
          fontWeight: 700,
          letterSpacing: "0.18em",
        }}
      >
        <div
          style={{
            width: 396,
            height: 396,
            borderRadius: 96,
            border: "12px solid rgba(255,255,255,0.18)",
            background: "rgba(15, 23, 42, 0.22)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 24px 60px rgba(15, 23, 42, 0.3)",
          }}
        >
          MC
        </div>
      </div>
    ),
    size,
  );
}
