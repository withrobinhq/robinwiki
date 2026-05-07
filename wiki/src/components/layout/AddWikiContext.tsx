"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Shared state for the "Add Wiki" creation modal. Both the Header dropdown
 * (legacy trigger, kept for one ship-cycle for muscle memory) and the
 * Sidebar "+ Add Wiki" trigger (A-game canonical location, line 421)
 * dispatch to the same modal via {@link useAddWiki}.
 *
 * The modal itself is mounted once by `(shell)/layout.tsx`, so the Header
 * and Sidebar never mount their own `<AddWikiModal>` instances.
 */
interface AddWikiContextValue {
  open: boolean;
  setOpen: (next: boolean) => void;
  openModal: () => void;
  closeModal: () => void;
}

const AddWikiContext = createContext<AddWikiContextValue | null>(null);

export function AddWikiProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openModal = useCallback(() => setOpen(true), []);
  const closeModal = useCallback(() => setOpen(false), []);
  const value = useMemo<AddWikiContextValue>(
    () => ({ open, setOpen, openModal, closeModal }),
    [open, openModal, closeModal],
  );
  return (
    <AddWikiContext.Provider value={value}>{children}</AddWikiContext.Provider>
  );
}

export function useAddWiki(): AddWikiContextValue {
  const ctx = useContext(AddWikiContext);
  if (!ctx) {
    throw new Error(
      "useAddWiki must be used inside <AddWikiProvider> — wrap your subtree in (shell)/layout.tsx.",
    );
  }
  return ctx;
}
