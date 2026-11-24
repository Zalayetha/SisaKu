import { MAX_CHANNEL_ACTION_LABEL_LENGTH, type ChannelAction } from "@anvia/channel";
import { WASTE_CAUSES, type WasteCause } from "@sisaku/db";
import { guessStage, type GuessLine, type WasteGuess } from "./guess";

/** The card is fixed code, so it speaks Bahasa Indonesia like the other fixed replies. */
export const CAUSE_LABELS: Record<WasteCause, string> = {
  over_prep: "Kelebihan masak",
  spoilage: "Basi",
  plate_waste: "Sisa piring",
  prep_error: "Salah masak",
  expired: "Kedaluwarsa",
};

export type Card = { text: string; actions?: readonly ChannelAction[] };

/**
 * Button codes: s save, e edit, x cancel, c<n> cause n of WASTE_CAUSES, i<n> candidate n.
 * `w:<uuid>:<code>` stays within Telegram's 64-byte callback data limit.
 */
export function actionId(guessId: string, code: string): string {
  return `w:${guessId}:${code}`;
}

export function parseActionId(id: string): { guessId: string; code: string } | undefined {
  const match = /^w:([0-9a-f-]{36}):([a-z]\d?)$/.exec(id);
  return match ? { guessId: match[1]!, code: match[2]! } : undefined;
}

/** Menu names are free text; Anvia refuses a button label longer than 80 characters. */
function buttonLabel(name: string): string {
  const chars = [...name];
  if (chars.length <= MAX_CHANNEL_ACTION_LABEL_LENGTH) return name;
  return `${chars
    .slice(0, MAX_CHANNEL_ACTION_LABEL_LENGTH - 1)
    .join("")
    .trimEnd()}…`;
}

const kg = (n: number) => `${n.toLocaleString("id-ID", { maximumFractionDigits: 3 })} kg`;

function lineText(line: GuessLine): string {
  if (line.weightKg !== undefined) return `${line.item.name}: ${kg(line.weightKg)}`;
  const est = line.portionCount * line.item.portionWeightKg;
  return `${line.item.name}: ${line.portionCount} porsi (≈${kg(est)})`;
}

function localDay(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(iso));
}

function whenText(guess: WasteGuess, today: string): string | undefined {
  if (localDay(guess.loggedAt, guess.timezone) === today) return undefined;
  const when = new Intl.DateTimeFormat("id-ID", {
    timeZone: guess.timezone,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(guess.loggedAt));
  return `Waktu: ${when}`;
}

/** The card for a guess in its current stage. `today` is the outlet's local date. */
export function renderCard(guess: WasteGuess, today: string): Card {
  const cancel = { id: actionId(guess.id, "x"), label: "Batal" };
  switch (guessStage(guess)) {
    case "unsure":
      return {
        text:
          "Saya kurang yakin dengan foto ini. Pilih menunya di bawah, atau ketik menu dan " +
          'jumlah porsinya (misalnya "nasi putih 3 porsi").',
        actions: [
          ...guess.candidates.map((item, i) => ({
            id: actionId(guess.id, `i${i}`),
            label: buttonLabel(item.name),
          })),
          cancel,
        ],
      };
    case "need_amount":
      return {
        text: `${guess.chosenItem!.name}: berapa porsi yang dibuang? Ketik jumlahnya (misalnya "3 porsi").`,
        actions: [cancel],
      };
    case "need_cause":
      return {
        text: [summary(guess, today), "", "Penyebabnya apa?"].join("\n"),
        // One button per cause and no Batal: Anvia sends at most MAX_CHANNEL_ACTIONS (5) actions,
        // and a sixth makes the whole card undeliverable (#53). Cancel from the next card instead.
        actions: WASTE_CAUSES.map((cause, i) => ({
          id: actionId(guess.id, `c${i}`),
          label: CAUSE_LABELS[cause],
        })),
      };
    case "ready":
      return {
        text: summary(guess, today),
        actions: [
          { id: actionId(guess.id, "s"), label: "Simpan", style: "primary" },
          { id: actionId(guess.id, "e"), label: "Ubah" },
          cancel,
        ],
      };
  }
}

function summary(guess: WasteGuess, today: string): string {
  const lines = guess.lines.map((l, i) => `${i + 1}. ${lineText(l)}`);
  const cause = guess.cause ? `Penyebab: ${CAUSE_LABELS[guess.cause]}` : undefined;
  const when = whenText(guess, today);
  return ["Limbah yang dicatat:", ...lines, cause, when].filter(Boolean).join("\n");
}

/** The card once saved: what was stored (items, weights, cause), no buttons. */
export function savedCard(
  entries: readonly {
    item_name: string;
    weight_kg: number;
    portion_count: number | null;
    cause: string;
  }[],
): Card {
  const lines = entries.map(
    (e, i) =>
      `${i + 1}. ${e.item_name}: ${e.portion_count !== null ? `${e.portion_count} porsi, ` : ""}${kg(e.weight_kg)}`,
  );
  // One Simpan stores one cause for every line.
  const stored = entries[0]?.cause;
  const cause = stored ? [`Penyebab: ${CAUSE_LABELS[stored as WasteCause] ?? stored}`] : [];
  return { text: ["Tersimpan ✓", ...lines, ...cause].join("\n") };
}

/** For the model: the open guess a follow-up message may correct. No ids beyond menu item ids. */
export function describeForModel(guess: WasteGuess): string {
  const stage = guessStage(guess);
  if (stage === "unsure") {
    return `unsure photo guess; candidates: ${guess.candidates.map((c) => `${c.name} (${c.id})`).join(", ")}; waiting for the user to name the item and portions.`;
  }
  if (stage === "need_amount") {
    return `item ${guess.chosenItem!.name} (${guess.chosenItem!.id}) chosen; waiting for the portion count.`;
  }
  const lines = guess.lines
    .map((l) =>
      l.weightKg !== undefined
        ? `${l.item.name} (${l.item.id}) ${l.weightKg} kg`
        : `${l.item.name} (${l.item.id}) ${l.portionCount} portions`,
    )
    .join("; ");
  return `${lines}; cause ${guess.cause ?? "not set"}; logged_at ${guess.loggedAt}.`;
}
