/**
 * Mock food banks for the MVP (surplus routing is P1, cut first). The names are deliberately
 * fictional ("Contoh" = example) so they cannot be mistaken for real organisations.
 */
export const FOOD_BANKS = [
  {
    id: "fb-jaksel-01",
    name: "Bank Pangan Contoh Jakarta Selatan",
    area: "Jakarta Selatan",
    capacity_note: "Mock: up to 80 portions per pickup, evenings",
  },
  {
    id: "fb-jaksel-02",
    name: "Dapur Berbagi Contoh Kebayoran",
    area: "Jakarta Selatan",
    capacity_note: "Mock: up to 40 portions per pickup, after 20:00",
  },
  {
    id: "fb-jakpus-01",
    name: "Lumbung Pangan Contoh Jakarta Pusat",
    area: "Jakarta Pusat",
    capacity_note: "Mock: up to 60 portions per pickup",
  },
  {
    id: "fb-bdg-01",
    name: "Bank Pangan Contoh Bandung",
    area: "Bandung",
    capacity_note: "Mock: up to 50 portions per pickup, evenings",
  },
  {
    id: "fb-bdg-02",
    name: "Rumah Pangan Contoh Dago",
    area: "Bandung",
    capacity_note: "Mock: up to 30 portions per pickup",
  },
] as const;

export type FoodBank = (typeof FOOD_BANKS)[number];

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Food banks whose area matches the location, ignoring case: either contains the other, so
 * "Jl. Kemang Raya, Jakarta Selatan" finds "Jakarta Selatan". No location returns all.
 */
export function matchFoodBanks(location: string | null | undefined): FoodBank[] {
  const loc = location ? norm(location) : "";
  if (!loc) return [...FOOD_BANKS];
  return FOOD_BANKS.filter((f) => {
    const area = norm(f.area);
    return loc.includes(area) || area.includes(loc);
  });
}

export const findFoodBank = (id: string) => FOOD_BANKS.find((f) => f.id === id);
