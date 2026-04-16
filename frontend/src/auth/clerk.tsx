"use client";

// NOTE: We intentionally keep this file very small and dependency-free.
// It provides CI/secretless-build safe fallbacks for Clerk hooks/components.

import { useContext, type ReactNode, type ComponentProps } from "react";

import {
  ClerkProvider,
  SignedIn as ClerkSignedIn,
  SignedOut as ClerkSignedOut,
  SignInButton as ClerkSignInButton,
  SignOutButton as ClerkSignOutButton,
  useAuth as clerkUseAuth,
  useUser as clerkUseUser,
} from "@clerk/nextjs";

import { isLikelyValidClerkPublishableKey } from "@/auth/clerkKey";
import { getLocalAuthToken, isLocalAuthMode } from "@/auth/localAuth";
import { AuthRuntimeContext } from "@/components/providers/AuthProvider";

function useLocalAuthState(): boolean {
  const runtime = useContext(AuthRuntimeContext);
  if (runtime.localMode) {
    return runtime.isAuthenticated;
  }
  return Boolean(getLocalAuthToken());
}

export function isClerkEnabled(): boolean {
  // IMPORTANT: keep this in sync with AuthProvider; otherwise components like
  // <SignedOut/> may render without a <ClerkProvider/> and crash during prerender.
  if (isLocalAuthMode()) return false;
  return isLikelyValidClerkPublishableKey(
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  );
}

export function SignedIn(props: { children: ReactNode }) {
  const hasToken = useLocalAuthState();
  if (isLocalAuthMode()) {
    return hasToken ? <>{props.children}</> : null;
  }
  if (!isClerkEnabled()) return null;
  return <ClerkSignedIn>{props.children}</ClerkSignedIn>;
}

export function SignedOut(props: { children: ReactNode }) {
  const hasToken = useLocalAuthState();
  if (isLocalAuthMode()) {
    return hasToken ? null : <>{props.children}</>;
  }
  if (!isClerkEnabled()) return <>{props.children}</>;
  return <ClerkSignedOut>{props.children}</ClerkSignedOut>;
}

// Keep the same prop surface as Clerk components so call sites don't need edits.
export function SignInButton(props: ComponentProps<typeof ClerkSignInButton>) {
  if (!isClerkEnabled()) return null;
  return <ClerkSignInButton {...props} />;
}

export function SignOutButton(
  props: ComponentProps<typeof ClerkSignOutButton>,
) {
  if (!isClerkEnabled()) return null;
  return <ClerkSignOutButton {...props} />;
}

export function useUser() {
  const hasToken = useLocalAuthState();
  if (isLocalAuthMode()) {
    return {
      isLoaded: true,
      isSignedIn: hasToken,
      user: null,
    } as const;
  }
  if (!isClerkEnabled()) {
    return { isLoaded: true, isSignedIn: false, user: null } as const;
  }
  return clerkUseUser();
}

export function useAuth() {
  const hasToken = useLocalAuthState();
  if (isLocalAuthMode()) {
    const token = getLocalAuthToken();
    return {
      isLoaded: true,
      isSignedIn: hasToken,
      userId: token ? "local-user" : null,
      sessionId: token ? "local-session" : null,
      getToken: async () => token,
    } as const;
  }
  if (!isClerkEnabled()) {
    return {
      isLoaded: true,
      isSignedIn: false,
      userId: null,
      sessionId: null,
      getToken: async () => null,
    } as const;
  }
  return clerkUseAuth();
}

// Re-export ClerkProvider for places that want to mount it, but strongly prefer
// gating via isClerkEnabled() at call sites.
export { ClerkProvider };
