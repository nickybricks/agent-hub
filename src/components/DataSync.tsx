"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

// Lets the chat tell the side panes "data changed, refetch" without a page
// reload. The chat bump()s a global revision counter when a turn / mutating
// tool finishes; panes refetch when the counter advances.
const Ctx = createContext<{ rev: number; bump: () => void }>({
  rev: 0,
  bump: () => {},
});

export function DataSyncProvider({ children }: { children: ReactNode }) {
  const [rev, setRev] = useState(0);
  const bump = useCallback(() => setRev((r) => r + 1), []);
  return <Ctx.Provider value={{ rev, bump }}>{children}</Ctx.Provider>;
}

/** Call to signal that mailbox data may have changed (used by the chat). */
export function useDataBump() {
  return useContext(Ctx).bump;
}

/**
 * Refetch when the global revision advances. If the pane is hidden when the
 * bump happens (keep-alive tabs), the refetch is deferred until it becomes
 * active again — no background thrash, but the data is fresh the moment the
 * user looks at it.
 */
export function useRevalidate(active: boolean, refetch: () => void) {
  const { rev } = useContext(Ctx);
  const seenRev = useRef(rev);
  const refetchRef = useRef(refetch);
  useEffect(() => {
    refetchRef.current = refetch;
  });

  useEffect(() => {
    if (active && seenRev.current !== rev) {
      seenRev.current = rev;
      refetchRef.current();
    }
  }, [active, rev]);
}
