import { paginate, type Page } from "./paginate";

export interface User {
  id: number;
  name: string;
}

export function listUsers(all: User[], page = 1, pageSize = 20): Page<User> {
  const sorted = [...all].sort((a, b) => a.id - b.id);
  return paginate(sorted, page, pageSize);
}
