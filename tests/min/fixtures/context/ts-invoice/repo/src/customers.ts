export interface Customer {
  id: string;
  name: string;
  country: string;
  exempt?: boolean;
}

export function displayName(c: Customer): string {
  return `${c.name} (${c.id})`;
}

export function byCountry(list: Customer[], country: string): Customer[] {
  return list.filter((c) => c.country === country);
}
