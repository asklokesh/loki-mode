// Open state of the New run picker. The sidebar, the Runs header, the palette and an Ask offer all open it through here.
import { useSyncExternalStore } from "react";

export interface NewRunState { open: boolean; /** owner/repo#N offered by Ask or chosen elsewhere; the picker still needs an explicit confirm. */ preset: string | null }

let state: NewRunState = { open: false, preset: null };
const listeners = new Set<() => void>();
const set = (s: NewRunState) => { state = s; for (const l of listeners) l(); };

export const openNewRun = (preset: string | null = null): void => set({ open: true, preset });
export const closeNewRun = (): void => set({ open: false, preset: null });
export const getNewRun = (): NewRunState => state;
export const useNewRun = (): NewRunState => useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, getNewRun, getNewRun);
