"use client";

import { AuthMode } from "@/auth/mode";
import {
  LOCAL_AUTH_CHANGE_EVENT,
  LOCAL_AUTH_PRESENCE_COOKIE,
  LOCAL_AUTH_STORAGE_KEY,
} from "@/auth/localAuthShared";

let localToken: string | null = null;
const EDGE_LOCAL_AUTH_SENTINEL = "__mc_edge_auth__";

function hasLocalAuthPresenceCookie(): boolean {
  if (typeof document === "undefined") return false;
  return document.cookie
    .split(";")
    .some((entry) => entry.trim() === `${LOCAL_AUTH_PRESENCE_COOKIE}=1`);
}

function syncLocalAuthPresenceCookie(present: boolean): void {
  if (typeof document === "undefined") return;
  const maxAge = present ? "31536000" : "0";
  document.cookie = `${LOCAL_AUTH_PRESENCE_COOKIE}=${present ? "1" : "0"}; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
}

export function isLocalAuthMode(): boolean {
  return process.env.NEXT_PUBLIC_AUTH_MODE === AuthMode.Local;
}

export function setLocalAuthToken(token: string): void {
  localToken = token;
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(LOCAL_AUTH_STORAGE_KEY, token);
    syncLocalAuthPresenceCookie(true);
    window.dispatchEvent(new Event(LOCAL_AUTH_CHANGE_EVENT));
  } catch {
    // Ignore storage failures (private mode / policy).
  }
}

export function getLocalAuthToken(): string | null {
  if (localToken) return localToken;
  if (typeof window === "undefined") return null;
  try {
    const stored = window.sessionStorage.getItem(LOCAL_AUTH_STORAGE_KEY);
    if (stored) {
      localToken = stored;
      syncLocalAuthPresenceCookie(true);
      return stored;
    }
  } catch {
    // Ignore storage failures (private mode / policy).
  }
  if (hasLocalAuthPresenceCookie()) {
    return EDGE_LOCAL_AUTH_SENTINEL;
  }
  return null;
}

export function clearLocalAuthToken(): void {
  localToken = null;
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(LOCAL_AUTH_STORAGE_KEY);
    syncLocalAuthPresenceCookie(false);
    window.dispatchEvent(new Event(LOCAL_AUTH_CHANGE_EVENT));
  } catch {
    // Ignore storage failures (private mode / policy).
  }
}
