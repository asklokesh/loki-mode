export interface Page<T> {
  items: T[];
  page: number;
  totalPages: number;
  hasNext: boolean;
}

/** Returns one page of `items`. Pages are 1-based. */
export function paginate<T>(items: T[], page: number, pageSize: number): Page<T> {
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new RangeError("pageSize must be a positive integer");
  }
  if (!Number.isInteger(page) || page < 1) {
    throw new RangeError("page must be an integer >= 1");
  }
  const totalPages = Math.ceil(items.length / pageSize);
  const start = (page - 1) * pageSize;
  const slice = items.slice(start, start + pageSize);
  return { items: slice, page, totalPages, hasNext: page < totalPages };
}
