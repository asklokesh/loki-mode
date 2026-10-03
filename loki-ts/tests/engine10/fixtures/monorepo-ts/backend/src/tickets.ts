export function countOpen(tickets: { open: boolean }[]): number {
  return tickets.filter((t) => t.open).length;
}
