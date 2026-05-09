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
 * Shared state for the "Add Wiki" creation modal. The Header dropdown is
 * the canonical trigger; any other surfaces (e.g. the Sidebar) dispatch
 * into the same modal via {@link useAddWiki}.
 *
 * The modal itself is mounted once by `(shell)/layout.tsx`, so triggers
 * never mount their own `<AddWikiModal>` instances.
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
