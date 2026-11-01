import { bulkDiscountRule } from "./bulkDiscount";
import { buyXGetYRule } from "./buyXGetY";
import { percentOffRule } from "./percentOff";
import { thresholdRule } from "./threshold";
import type { PricingRule } from "./types";

export class RuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleError";
  }
}

type Builder = (args: string[]) => PricingRule;

const num = (s: string): number => {
  if (!/^\d+$/.test(s)) throw new RangeError(`not a whole number: ${s}`);
  return Number(s);
};
const text = (s: string): string => {
  if (s === "") throw new RangeError("empty name");
  return s;
};

/** Rule name -> [argument count, builder]. */
const REGISTRY: Record<string, [number, Builder]> = {
  bulk: [2, ([q, c]) => bulkDiscountRule(num(q), num(c))],
  "buy-x-get-y": [3, ([s, b, f]) => buyXGetYRule(text(s), num(b), num(f))],
  "percent-off": [2, ([c, p]) => percentOffRule(text(c), num(p))],
  threshold: [2, ([m, o]) => thresholdRule(num(m), num(o))],
};

export function ruleNames(): string[] {
  return Object.keys(REGISTRY).sort();
}

/** Builds a rule from a spec such as "percent-off:shirts:15". */
export function parseRule(spec: string): PricingRule {
  const [name, ...args] = spec.trim().split(":");
  const entry = Object.hasOwn(REGISTRY, name) ? REGISTRY[name] : undefined;
  if (!entry) throw new RuleError(`unknown rule "${name}"`);
  const [arity, build] = entry;
  if (args.length !== arity) throw new RuleError(`bad rule spec "${spec}"`);
  try {
    return build(args);
  } catch {
    throw new RuleError(`bad rule spec "${spec}"`);
  }
}

export function parseRules(specs: string[]): PricingRule[] {
  return specs.map(parseRule);
}
