import { useEffect, useRef, useCallback } from 'react';

/**
 * Stack-based global escape key handler. Each overlay registers itself;
 * pressing Escape closes the topmost overlay (LIFO order).
 */

// Global stack of close handlers
const escapeStack: Array<() => void> = [];

function globalHandler(e: KeyboardEvent) {
  if (e.key === 'Escape' && escapeStack.length > 0) {
    e.preventDefault();
    e.stopPropagation();
    // Close the topmost overlay
    const top = escapeStack[escapeStack.length - 1];
    top();
  }
}

let listenerAttached = false;

function ensureListener() {
  if (!listenerAttached) {
    document.addEventListener('keydown', globalHandler);
    listenerAttached = true;
  }
}

/**
 * Register an overlay's close handler on the escape key stack.
 * When the overlay is open, pressing Escape will call onClose.
 * Multiple overlays stack in LIFO order.
 *
 * @param isOpen - Whether the overlay is currently open
 * @param onClose - Callback to close the overlay
 */
export function useEscapeKey(isOpen: boolean, onClose: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const stableClose = useCallback(() => {
    closeRef.current();
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    ensureListener();
    escapeStack.push(stableClose);

    return () => {
      const idx = escapeStack.indexOf(stableClose);
      if (idx !== -1) {
        escapeStack.splice(idx, 1);
      }
    };
  }, [isOpen, stableClose]);
}
