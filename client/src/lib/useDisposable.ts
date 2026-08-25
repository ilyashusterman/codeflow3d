/**
 * GPU resources tied to a memo.
 *
 * Disposing in a `useEffect` cleanup looks right but breaks under React's
 * StrictMode: the simulated unmount/remount runs the cleanup while `useMemo`
 * keeps its cached value, so the second mount renders an already-disposed
 * geometry and three throws on its nulled attributes. Instead, dispose the
 * *previous* value when a new one is built — the resource lives exactly as long
 * as the value that replaced it needs it to.
 */
import { useMemo, useRef } from "react";

export function useDisposable<T>(
  factory: () => T,
  deps: unknown[],
  dispose: (value: T) => void,
): T {
  const previous = useRef<T | null>(null);
  return useMemo(() => {
    if (previous.current !== null) dispose(previous.current);
    const next = factory();
    previous.current = next;
    return next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

interface Disposable {
  dispose(): void;
}

/** Convenience wrapper for anything with a `dispose()` method. */
export function useDisposed<T extends Disposable>(factory: () => T, deps: unknown[]): T {
  return useDisposable(factory, deps, (v) => v.dispose());
}
