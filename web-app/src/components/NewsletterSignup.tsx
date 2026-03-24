import { useState } from 'react';
import { Mail, Check } from 'lucide-react';

export function NewsletterSignup() {
  const [email, setEmail] = useState('');
  const [subscribed, setSubscribed] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const trimmed = email.trim();
    if (!trimmed) return;

    // Basic email validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError('Please enter a valid email address.');
      return;
    }

    // In a real app, this would call an API endpoint
    // For now, store in localStorage and show success
    try {
      const existing = JSON.parse(localStorage.getItem('pl_newsletter_emails') || '[]');
      if (!existing.includes(trimmed)) {
        existing.push(trimmed);
        localStorage.setItem('pl_newsletter_emails', JSON.stringify(existing));
      }
    } catch {
      // Ignore storage errors
    }

    setSubscribed(true);
    setEmail('');
  };

  if (subscribed) {
    return (
      <div className="flex items-center gap-2 py-3 px-4 rounded-xl bg-[#1FC5A8]/10 border border-[#1FC5A8]/20">
        <Check size={16} className="text-[#1FC5A8] flex-shrink-0" />
        <span className="text-sm text-[#36342E] font-medium">
          Thanks for subscribing! We will keep you posted.
        </span>
      </div>
    );
  }

  return (
    <div className="py-3">
      <div className="flex items-center gap-2 mb-2">
        <Mail size={14} className="text-[#6B6960]" />
        <span className="text-sm text-[#6B6960]">
          Get updates on new features and tips
        </span>
      </div>
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="flex-1 px-3 py-2 text-sm rounded-lg border border-[#ECEAE3] bg-white focus:outline-none focus:ring-2 focus:ring-[#553DE9]/30 focus:border-[#553DE9]/40"
        />
        <button
          type="submit"
          className="px-4 py-2 text-sm font-semibold rounded-lg bg-[#553DE9] text-white hover:bg-[#4832c7] transition-colors"
        >
          Subscribe
        </button>
      </form>
      {error && (
        <p className="mt-1.5 text-xs text-[#C45B5B]">{error}</p>
      )}
    </div>
  );
}
