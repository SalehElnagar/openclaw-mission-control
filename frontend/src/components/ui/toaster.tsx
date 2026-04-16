"use client";

import { Toaster as SonnerToaster } from "sonner";

import { useTheme } from "@/components/providers/ThemeProvider";

export function Toaster() {
  const { theme } = useTheme();

  return (
    <SonnerToaster
      theme={theme as "light" | "dark"}
      position="bottom-right"
      richColors
      closeButton
      toastOptions={{
        className: "font-body",
        style: {
          fontFamily: "var(--font-body)",
        },
      }}
    />
  );
}
