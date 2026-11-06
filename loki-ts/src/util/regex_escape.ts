/** Escape every regex metacharacter in s so it matches literally inside a RegExp. */
export const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
