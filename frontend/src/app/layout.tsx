import "./globals.css";

import type { Metadata } from "next";
import type { ReactNode } from "react";
import { cookies } from "next/headers";

import { DM_Serif_Display, IBM_Plex_Sans, Sora } from "next/font/google";

import { AuthMode } from "@/auth/mode";
import { LOCAL_AUTH_PRESENCE_COOKIE } from "@/auth/localAuthShared";
import { AuthProvider } from "@/components/providers/AuthProvider";
import { LocalAuthBootstrap } from "@/components/providers/LocalAuthBootstrap";
import { QueryProvider } from "@/components/providers/QueryProvider";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
import { GlobalLoader } from "@/components/ui/global-loader";
import { Toaster } from "@/components/ui/toaster";
import { CommandPalette } from "@/components/organisms/CommandPalette";
import { LocalAuthLogin } from "@/components/organisms/LocalAuthLogin";

export const metadata: Metadata = {
  title: {
    default: "MC Delivery",
    template: "%s | MC Delivery",
  },
  applicationName: "MC Delivery",
  description: "A calm command center for every task.",
  icons: {
    icon: "/icon",
    apple: "/apple-icon",
  },
};

const bodyFont = IBM_Plex_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-body",
  weight: ["400", "500", "600", "700"],
});

const headingFont = Sora({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-heading",
  weight: ["500", "600", "700"],
});

const displayFont = DM_Serif_Display({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-display",
  weight: ["400"],
});

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  const cookieStore = await cookies();
  const initialLocalAuthPresence =
    process.env.NEXT_PUBLIC_AUTH_MODE === AuthMode.Local &&
    cookieStore.get(LOCAL_AUTH_PRESENCE_COOKIE)?.value === "1";
  return (
    <html lang="en" suppressHydrationWarning>
      <head />
      <body
        className={`${bodyFont.variable} ${headingFont.variable} ${displayFont.variable} min-h-screen bg-app text-strong antialiased`}
      >
        <ThemeProvider>
          {process.env.NEXT_PUBLIC_AUTH_MODE === AuthMode.Local &&
          !initialLocalAuthPresence ? (
            <>
              <LocalAuthBootstrap />
              <Toaster />
              <LocalAuthLogin />
            </>
          ) : (
            <AuthProvider initialLocalAuthPresence={initialLocalAuthPresence}>
              <QueryProvider>
                <GlobalLoader />
                <Toaster />
                <CommandPalette />
                {children}
              </QueryProvider>
            </AuthProvider>
          )}
        </ThemeProvider>
      </body>
    </html>
  );
}
