export function search(query: string, items: string[]): string[] {
  const q = query.toLowerCase();
  return items.filter((item) => item.toLowerCase().includes(q));
}
