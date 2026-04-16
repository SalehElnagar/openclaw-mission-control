import { ImageResponse } from "next/og";

const size = { width: 180, height: 180 };

export const contentType = "image/png";

export default function AppleIcon(): ImageResponse {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          borderRadius: 42,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background:
            "linear-gradient(135deg, #0f172a 0%, #2563eb 55%, #60a5fa 100%)",
          color: "#fff",
          fontFamily: "sans-serif",
          fontWeight: 700,
          letterSpacing: "0.14em",
          fontSize: 62,
          boxShadow: "0 14px 34px rgba(15, 23, 42, 0.28)",
        }}
      >
        MC
      </div>
    ),
    size,
  );
}
