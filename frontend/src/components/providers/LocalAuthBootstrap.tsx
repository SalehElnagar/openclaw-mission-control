"use client";

import { useEffect } from "react";

import { getLocalAuthToken, isLocalAuthMode, setLocalAuthToken } from "@/auth/localAuth";

export function LocalAuthBootstrap() {
  useEffect(() => {
    if (!isLocalAuthMode()) {
      return;
    }
    const token = getLocalAuthToken();
    if (!token) {
      return;
    }
    setLocalAuthToken(token);
    window.location.reload();
  }, []);

  return null;
}
