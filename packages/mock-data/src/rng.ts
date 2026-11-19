/** Small seeded PRNG (mulberry32). Same seed gives the same sequence. */
export interface Rng {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  normal(mean?: number, sd?: number): number;
  chance(p: number): boolean;
  uuid(): string;
}

export function hashSeed(input: string | number): number {
  const s = String(input);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function createRng(seed: string | number): Rng {
  let a = hashSeed(seed);
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(next() * 16).toString(16)).join("");
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)]!,
    normal(mean = 0, sd = 1) {
      const u = Math.max(next(), 1e-12);
      return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
    },
    chance: (p) => next() < p,
    // Deterministic v4-shaped UUID so ids are stable for a given seed.
    uuid: () =>
      `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[Math.floor(next() * 4)]}${hex(3)}-${hex(12)}`,
  };
}
