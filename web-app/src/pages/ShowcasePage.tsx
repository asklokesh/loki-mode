import { Sparkles } from 'lucide-react';

export default function ShowcasePage() {
  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Sparkles size={24} className="text-[#553DE9] dark:text-[#8B7BF7]" />
        <h1 className="text-2xl font-heading font-bold text-[#36342E] dark:text-[#F5F3EE]">
          Showcase
        </h1>
      </div>
      <p className="text-[#6B6960] dark:text-[#A8A49A]">
        Featured projects and demos built with Loki Mode.
      </p>
    </div>
  );
}
