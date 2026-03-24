interface DividerProps {
  label?: string;
  className?: string;
}

export function Divider({ label, className = '' }: DividerProps) {
  if (!label) {
    return <hr className={`border-t border-[#ECEAE3] dark:border-[#2A2A30] ${className}`} />;
  }

  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <span className="flex-1 border-t border-[#ECEAE3] dark:border-[#2A2A30]" />
      <span className="text-xs text-muted font-medium">{label}</span>
      <span className="flex-1 border-t border-[#ECEAE3] dark:border-[#2A2A30]" />
    </div>
  );
}
