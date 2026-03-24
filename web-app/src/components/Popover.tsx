import { useState, useRef, useEffect, useCallback } from 'react';

type PopoverPosition = 'top' | 'bottom' | 'left' | 'right';

interface PopoverProps {
  trigger: React.ReactNode;
  position?: PopoverPosition;
  className?: string;
  children: React.ReactNode;
}

export function Popover({
  trigger,
  position = 'bottom',
  className = '',
  children,
}: PopoverProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
      setOpen(false);
    }
  }, []);

  const handleEscape = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false);
  }, []);

  useEffect(() => {
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleEscape);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
        document.removeEventListener('keydown', handleEscape);
      };
    }
  }, [open, handleClickOutside, handleEscape]);

  const positionClasses: Record<PopoverPosition, string> = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-3',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-3',
    left: 'right-full top-1/2 -translate-y-1/2 mr-3',
    right: 'left-full top-1/2 -translate-y-1/2 ml-3',
  };

  const arrowClasses: Record<PopoverPosition, string> = {
    top: 'top-full left-1/2 -translate-x-1/2 border-t-white border-x-transparent border-b-transparent dark:border-t-[#1A1A1E]',
    bottom: 'bottom-full left-1/2 -translate-x-1/2 border-b-white border-x-transparent border-t-transparent dark:border-b-[#1A1A1E]',
    left: 'left-full top-1/2 -translate-y-1/2 border-l-white border-y-transparent border-r-transparent dark:border-l-[#1A1A1E]',
    right: 'right-full top-1/2 -translate-y-1/2 border-r-white border-y-transparent border-l-transparent dark:border-r-[#1A1A1E]',
  };

  return (
    <div className={`relative inline-flex ${className}`} ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="inline-flex"
      >
        {trigger}
      </button>
      {open && (
        <div
          className={`absolute z-50 min-w-[200px] bg-white border border-[#ECEAE3] rounded-lg shadow-xl p-3 dark:bg-[#1A1A1E] dark:border-[#2A2A30] ${positionClasses[position]}`}
        >
          <span className={`absolute w-0 h-0 border-[6px] ${arrowClasses[position]}`} />
          {children}
        </div>
      )}
    </div>
  );
}
