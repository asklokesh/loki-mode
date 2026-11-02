export interface LineItem {
  sku: string;
  category: string;
  unitCents: number;
  qty: number;
}

export interface Cart {
  items: LineItem[];
}

export function subtotalCents(cart: Cart): number {
  return cart.items.reduce((sum, item) => sum + item.unitCents * item.qty, 0);
}
