"use client";

import { ClerkProvider } from "@clerk/nextjs";
import {
  createContext,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { isLikelyValidClerkPublishableKey } from "@/auth/clerkKey";
import {
  clearLocalAuthToken,
  getLocalAuthToken,
  isLocalAuthMode,
} from "@/auth/localAuth";
import { LOCAL_AUTH_CHANGE_EVENT } from "@/auth/localAuthShared";
import { LocalAuthLogin } from "@/components/organisms/LocalAuthLogin";

export const AuthRuntimeContext = createContext({
  localMode: false,
  isAuthenticated: false,
});

export function AuthProvider({
  children,
  initialLocalAuthPresence = false,
}: {
  children: ReactNode;
  initialLocalAuthPresence?: boolean;
}) {
  const localMode = isLocalAuthMode();
  const hasLocalToken = useSyncExternalStore(
    (onStoreChange) => {
      if (typeof window === "undefined") {
        return () => undefined;
      }
      const handleStorage = (event: StorageEvent) => {
        if (event.key === null || event.key === "mc_local_auth_token") {
          onStoreChange();
        }
      };
      const handleLocalAuthChange = () => onStoreChange();
      window.addEventListener("storage", handleStorage);
      window.addEventListener(LOCAL_AUTH_CHANGE_EVENT, handleLocalAuthChange);
      return () => {
        window.removeEventListener("storage", handleStorage);
        window.removeEventListener(
          LOCAL_AUTH_CHANGE_EVENT,
          handleLocalAuthChange,
        );
      };
    },
    () => (localMode ? Boolean(getLocalAuthToken()) : false),
    () => initialLocalAuthPresence,
  );

  useEffect(() => {
    if (!localMode) {
      clearLocalAuthToken();
    }
  }, [localMode]);

  if (localMode) {
    if (!hasLocalToken) {
      return (
        <AuthRuntimeContext.Provider
          value={{ localMode: true, isAuthenticated: false }}
        >
          <LocalAuthLogin />
        </AuthRuntimeContext.Provider>
      );
    }
    return (
      <AuthRuntimeContext.Provider
        value={{ localMode: true, isAuthenticated: true }}
      >
        {children}
      </AuthRuntimeContext.Provider>
    );
  }

  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const afterSignOutUrl =
    process.env.NEXT_PUBLIC_CLERK_AFTER_SIGN_OUT_URL ?? "/";

  if (!isLikelyValidClerkPublishableKey(publishableKey)) {
    return (
      <AuthRuntimeContext.Provider
        value={{ localMode: false, isAuthenticated: false }}
      >
        {children}
      </AuthRuntimeContext.Provider>
    );
  }

  return (
    <AuthRuntimeContext.Provider
      value={{ localMode: false, isAuthenticated: false }}
    >
      <ClerkProvider
        publishableKey={publishableKey}
        afterSignOutUrl={afterSignOutUrl}
      >
        {children}
      </ClerkProvider>
    </AuthRuntimeContext.Provider>
  );
}
