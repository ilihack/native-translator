/**
 * Vitest global setup — runs before every test file.
 * Imports @testing-library/jest-dom to extend Vitest's expect()
 * with DOM matchers (toBeInTheDocument, toHaveAttribute, etc.).
 *
 * Also shims browser APIs that jsdom does not implement:
 *   - window.matchMedia  (used by Radix UI / shadcn components)
 *   - ResizeObserver     (used by some Radix primitives)
 */
import '@testing-library/jest-dom';

// ─── Browser-only shims (jsdom environment only) ─────────────────────────────
// Guard against running in Node environment (e.g. server tests with
// // @vitest-environment node) where `window` is not defined.
if (typeof window !== 'undefined') {
  // window.matchMedia shim — jsdom does not implement it; Radix/shadcn call it
  // to detect prefers-color-scheme / prefers-reduced-motion.
  // Stub always reports the media query as NOT matching.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });

  // ResizeObserver shim — some Radix primitives use it.
  if (typeof (globalThis as any).ResizeObserver === 'undefined') {
    (globalThis as any).ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
}
