import { ArrowLeftRight } from 'lucide-react';

export default function ComparePage() {
  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <ArrowLeftRight size={24} className="text-[#553DE9] dark:text-[#8B7BF7]" />
        <h1 className="text-2xl font-heading font-bold text-[#36342E] dark:text-[#F5F3EE]">
          Compare
        </h1>
      </div>
      <p className="text-[#6B6960] dark:text-[#A8A49A]">
        Compare project runs, providers, and configuration outcomes side by side.
      </p>
    </div>
  );
}
