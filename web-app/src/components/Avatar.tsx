type AvatarSize = 'sm' | 'md' | 'lg';
type AvatarStatus = 'online' | 'offline' | 'away';

interface AvatarProps {
  name: string;
  image?: string;
  size?: AvatarSize;
  status?: AvatarStatus;
  className?: string;
}

const SIZE_MAP: Record<AvatarSize, { container: string; text: string; dot: string }> = {
  sm: { container: 'w-6 h-6', text: 'text-[10px]', dot: 'w-2 h-2 -bottom-0.5 -right-0.5' },
  md: { container: 'w-8 h-8', text: 'text-xs', dot: 'w-2.5 h-2.5 -bottom-0.5 -right-0.5' },
  lg: { container: 'w-11 h-11', text: 'text-sm', dot: 'w-3 h-3 -bottom-0.5 -right-0.5' },
};

const STATUS_COLOR: Record<AvatarStatus, string> = {
  online: 'bg-[#1FC5A8]',
  offline: 'bg-[#939084]',
  away: 'bg-[#E5A940]',
};

function hashName(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash);
}

const BG_COLORS = [
  'bg-[#553DE9]',
  'bg-[#D63384]',
  'bg-[#1FC5A8]',
  'bg-[#E5A940]',
  'bg-[#3B82F6]',
  'bg-[#8B5CF6]',
  'bg-[#EC4899]',
  'bg-[#06B6D4]',
];

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return (parts[0]?.[0] || '?').toUpperCase();
}

export function Avatar({ name, image, size = 'md', status, className = '' }: AvatarProps) {
  const s = SIZE_MAP[size];
  const bgColor = BG_COLORS[hashName(name) % BG_COLORS.length];
  const initials = getInitials(name);

  return (
    <span className={`relative inline-flex flex-shrink-0 ${className}`}>
      {image ? (
        <img
          src={image}
          alt={name}
          className={`${s.container} rounded-full object-cover`}
        />
      ) : (
        <span
          className={`${s.container} ${bgColor} rounded-full inline-flex items-center justify-center text-white font-semibold ${s.text}`}
          title={name}
        >
          {initials}
        </span>
      )}
      {status && (
        <span
          className={`absolute ${s.dot} ${STATUS_COLOR[status]} rounded-full border-2 border-white dark:border-[#1A1A1E]`}
          title={status}
        />
      )}
    </span>
  );
}
