import { X } from 'lucide-react';

type TagColor = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

interface TagProps {
  label: string;
  color?: TagColor;
  removable?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
  className?: string;
}

const COLOR_MAP: Record<TagColor, string> = {
  default: 'bg-[#F8F4F0] text-[#36342E] border-[#ECEAE3] dark:bg-[#222228] dark:text-[#E8E6E3] dark:border-[#2A2A30]',
  primary: 'bg-[#553DE9]/10 text-[#553DE9] border-[#553DE9]/20 dark:bg-[#553DE9]/20 dark:text-[#7B6BEF] dark:border-[#553DE9]/30',
  success: 'bg-[#1FC5A8]/10 text-[#1FC5A8] border-[#1FC5A8]/20',
  warning: 'bg-[#E5A940]/10 text-[#E5A940] border-[#E5A940]/20',
  danger: 'bg-[#C45B5B]/10 text-[#C45B5B] border-[#C45B5B]/20',
  info: 'bg-[#3B82F6]/10 text-[#3B82F6] border-[#3B82F6]/20',
};

export function Tag({
  label,
  color = 'default',
  removable = false,
  onClick,
  onRemove,
  className = '',
}: TagProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2.5 py-0.5 text-xs font-medium rounded-full border transition-colors ${COLOR_MAP[color]} ${
        onClick ? 'cursor-pointer hover:opacity-80' : ''
      } ${className}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
    >
      {label}
      {removable && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove?.(); }}
          className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
          aria-label={`Remove ${label}`}
        >
          <X size={10} />
        </button>
      )}
    </span>
  );
}
