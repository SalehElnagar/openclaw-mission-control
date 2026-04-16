import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { ThemeToggle } from "@/components/ui/theme-toggle";

import { ThemeProvider, themeStorageKey } from "./ThemeProvider";

const installMatchMediaMock = (matches: boolean) => {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mediaQueryList: MediaQueryList = {
    matches,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
    addListener: (listener) => {
      listeners.add(listener);
    },
    removeListener: (listener) => {
      listeners.delete(listener);
    },
    dispatchEvent: vi.fn(),
  };
  vi.stubGlobal("matchMedia", vi.fn(() => mediaQueryList));
};

const createStorageMock = (): Storage => {
  let storage: Record<string, string> = {};
  return {
    get length() {
      return Object.keys(storage).length;
    },
    clear: () => {
      storage = {};
    },
    getItem: (key) => storage[key] ?? null,
    key: (index) => Object.keys(storage)[index] ?? null,
    removeItem: (key) => {
      delete storage[key];
    },
    setItem: (key, value) => {
      storage[key] = String(value);
    },
  };
};

describe("ThemeProvider", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      value: createStorageMock(),
      configurable: true,
      writable: true,
    });
    document.documentElement.classList.remove("dark");
    document.documentElement.removeAttribute("data-theme");
    vi.unstubAllGlobals();
  });

  it("applies persisted theme from localStorage", async () => {
    window.localStorage.setItem(themeStorageKey, "light");
    installMatchMediaMock(true);

    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.classList.contains("dark")).toBe(false);
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    });
  });

  it("toggles theme and persists selection", async () => {
    installMatchMediaMock(false);

    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    const toggle = await screen.findByRole("button", {
      name: /switch to dark mode/i,
    });

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(document.documentElement.classList.contains("dark")).toBe(true);
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
      expect(window.localStorage.getItem(themeStorageKey)).toBe("dark");
    });
  });
});
