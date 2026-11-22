import type { WasteCause } from "@sisaku/db";

/** Below this, a photo guess is "unsure" and cannot be saved until a person supplies it (ADR 0014). */
export const CONFIDENCE_THRESHOLD = 0.6;
export const GUESS_TTL_MS = 30 * 60 * 1000;
export const MAX_LINES = 5;
export const MAX_CANDIDATES = 3;

export type MenuItem = { id: string; name: string; portionWeightKg: number };

/** One menu item in a waste guess, with exactly one of a portion count or a typed weight. */
export type GuessLine =
  | { item: MenuItem; portionCount: number; weightKg?: undefined }
  | { item: MenuItem; weightKg: number; portionCount?: undefined };

/** What the model first guessed, kept to compare with what the user saves. */
export type GuessSnapshot = {
  lines: readonly {
    itemId: string;
    portionCount?: number | undefined;
    weightKg?: number | undefined;
  }[];
  cause?: WasteCause | undefined;
  loggedAt: string;
  unsure: boolean;
};

/** A waste guess waiting for a confirmation. Lives in memory only (ADR 0014). */
export type WasteGuess = {
  id: string;
  userId: string;
  outletId: string;
  chatId: string;
  timezone: string;
  source: "photo" | "text";
  photo?: { data: Buffer; mediaType: string } | undefined;
  /** The model's confidence, photo guesses only. */
  confidence?: number | undefined;
  /** Set once a person supplied the item and amount after an unsure guess. */
  userSupplied: boolean;
  /** Likely items offered as buttons for an unsure guess. */
  candidates: readonly MenuItem[];
  /** The candidate the user tapped, waiting for a portion count. */
  chosenItem?: MenuItem | undefined;
  lines: readonly GuessLine[];
  cause?: WasteCause | undefined;
  /** ISO 8601 with offset. */
  loggedAt: string;
  original: GuessSnapshot;
  /** Lens trace of the turn that produced this version of the guess. */
  traceId?: string | undefined;
  /** The Telegram message showing this guess's card, once sent. */
  cardMessageId?: string | undefined;
  createdAtMs: number;
};

export type GuessStage = "unsure" | "need_amount" | "need_cause" | "ready";

export function isUnsure(guess: Pick<WasteGuess, "userSupplied" | "confidence">): boolean {
  return (
    !guess.userSupplied && guess.confidence !== undefined && guess.confidence < CONFIDENCE_THRESHOLD
  );
}

/** Which question the card asks next. Only "ready" can be saved. */
export function guessStage(guess: WasteGuess): GuessStage {
  if (isUnsure(guess)) return guess.chosenItem ? "need_amount" : "unsure";
  if (!guess.cause) return "need_cause";
  return "ready";
}

export function snapshot(
  guess: Pick<WasteGuess, "lines" | "cause" | "loggedAt" | "userSupplied" | "confidence">,
): GuessSnapshot {
  return {
    lines: guess.lines.map((l) => ({
      itemId: l.item.id,
      portionCount: l.portionCount,
      weightKg: l.weightKg,
    })),
    cause: guess.cause,
    loggedAt: guess.loggedAt,
    unsure: isUnsure(guess),
  };
}

/**
 * Field names the user changed between the model's first guess and what was saved. Choosing a
 * cause the model left open is not a change. Names only, never values (Lens safe mode).
 */
export function changedFields(original: GuessSnapshot, saved: GuessSnapshot): string[] {
  const fields = new Set<string>();
  if (saved.lines.length > original.lines.length) fields.add("lines_added");
  if (saved.lines.length < original.lines.length) fields.add("lines_removed");
  original.lines.forEach((before, i) => {
    const after = saved.lines[i];
    if (!after) return;
    if (before.itemId !== after.itemId) fields.add("item");
    if (before.portionCount !== after.portionCount) fields.add("portion_count");
    if (before.weightKg !== after.weightKg) fields.add("weight_kg");
  });
  if (original.cause !== undefined && original.cause !== saved.cause) fields.add("cause");
  if (Date.parse(original.loggedAt) !== Date.parse(saved.loggedAt)) fields.add("logged_at");
  return [...fields].sort();
}

/** In-memory waste guesses, by id. Expired guesses read as missing; a restart loses them all. */
export class GuessStore {
  readonly #guesses = new Map<string, WasteGuess>();

  constructor(
    private readonly now: () => Date,
    private readonly ttlMs = GUESS_TTL_MS,
  ) {}

  #expired(guess: WasteGuess): boolean {
    return this.now().getTime() - guess.createdAtMs >= this.ttlMs;
  }

  add(guess: WasteGuess): void {
    for (const [id, g] of this.#guesses) if (this.#expired(g)) this.#guesses.delete(id);
    this.#guesses.set(guess.id, guess);
  }

  get(id: string): WasteGuess | undefined {
    const guess = this.#guesses.get(id);
    if (!guess) return undefined;
    if (this.#expired(guess)) {
      this.#guesses.delete(id);
      return undefined;
    }
    return guess;
  }

  delete(id: string): void {
    this.#guesses.delete(id);
  }

  /** The newest unexpired guess in a chat: the one a follow-up text message may correct. */
  openIn(chatId: string): WasteGuess | undefined {
    let latest: WasteGuess | undefined;
    for (const g of this.#guesses.values()) {
      if (g.chatId !== chatId || this.#expired(g)) continue;
      if (!latest || g.createdAtMs >= latest.createdAtMs) latest = g;
    }
    return latest;
  }
}
