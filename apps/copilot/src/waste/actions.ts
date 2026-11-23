import type { McpServer } from "@anvia/core/mcp";
import { callMcpTool, COPILOT_INSTRUCTIONS_VERSION } from "@sisaku/agents";
import { agentRuns, menuItems, WASTE_CAUSES, wasteEntries } from "@sisaku/db";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../users";
import { renderCard, savedCard, type Card } from "./card";
import { sendScore, type FeedbackScorer, type Log } from "./feedback";
import { changedFields, guessStage, snapshot, type GuessStore, type WasteGuess } from "./guess";
import { photoPath, type PhotoStore } from "./photos";

export const EXPIRED_TEXT =
  "Draft ini sudah kedaluwarsa atau tidak ditemukan. Kirim foto atau teksnya lagi.";
export const NOT_YOURS_TEXT = "Hanya pengirim draft ini yang bisa menekan tombolnya.";
export const NOT_READY_TEXT =
  "Belum bisa disimpan. Lengkapi dulu menu, jumlah porsi dan penyebabnya.";
export const ALREADY_SAVED_TEXT = "Draft ini sudah tersimpan.";
export const ALREADY_CANCELLED_TEXT = "Draft ini sudah dibatalkan.";
export const ALREADY_REPLACED_TEXT = "Draft ini sudah diganti dengan draft yang lebih baru.";

const SETTLED_TEXT = {
  saved: ALREADY_SAVED_TEXT,
  cancelled: ALREADY_CANCELLED_TEXT,
  replaced: ALREADY_REPLACED_TEXT,
} as const;
export const SAVE_FAILED_TEXT =
  "Gagal menyimpan, belum ada yang tercatat. Tekan Simpan lagi sebentar lagi.";
export const ASK_CORRECTION_TEXT =
  'Apa yang salah? Ketik koreksinya, misalnya "nasi putih 4 porsi" atau "penyebabnya basi".';

export type WasteActionDeps = {
  db: Db;
  servers: readonly McpServer[];
  store: GuessStore;
  photos: PhotoStore;
  scorer: FeedbackScorer;
  log: Log;
};

/** What a button tap produces: an edit of the tapped card, and/or a new message. */
export type ActionOutcome = { edit?: Card; reply?: string };

type SavedEntry = {
  id: string;
  item_name: string;
  weight_kg: number;
  portion_count: number | null;
  cause: string;
};

/**
 * Handles one tap on a waste card. Only the creator's Simpan on a ready guess saves anything,
 * and only here does fixed code call `log_waste` (ADR 0014).
 */
export async function handleWasteAction(
  input: { guessId: string; code: string; userId: string; messageId: string; today: string },
  deps: WasteActionDeps,
): Promise<ActionOutcome> {
  const guess = deps.store.get(input.guessId);
  if (!guess) {
    // A late tap on a settled card leaves that card's final text in place.
    const outcome = deps.store.outcomeOf(input.guessId);
    if (outcome) return { reply: SETTLED_TEXT[outcome] };
    return { edit: { text: "Draft kedaluwarsa." }, reply: EXPIRED_TEXT };
  }
  if (guess.userId !== input.userId) return { reply: NOT_YOURS_TEXT };
  guess.cardMessageId = input.messageId;

  const { code } = input;
  if (code === "x") {
    deps.store.settle(guess.id, "cancelled");
    return { edit: { text: "Dibatalkan." } };
  }
  if (code === "e") return { reply: ASK_CORRECTION_TEXT };
  if (code.startsWith("c")) {
    const cause = WASTE_CAUSES[Number(code.slice(1))];
    if (!cause || guessStage(guess) !== "need_cause") return {};
    guess.cause = cause;
    return { edit: renderCard(guess, input.today) };
  }
  if (code.startsWith("i")) {
    const item = guess.candidates[Number(code.slice(1))];
    if (!item || guessStage(guess) !== "unsure") return {};
    guess.chosenItem = item;
    return { edit: renderCard(guess, input.today) };
  }
  if (code === "s") {
    if (guessStage(guess) !== "ready") return { reply: NOT_READY_TEXT };
    if (guess.saving) return {};
    guess.saving = true;
    try {
      const entries = await saveGuess(guess, deps);
      deps.store.settle(guess.id, "saved");
      return { edit: savedCard(entries) };
    } catch (error) {
      // kitchen-mcp saved no line, so the guess stays open and Simpan can be tapped again.
      deps.log("Saving a waste guess failed", error);
      return { reply: SAVE_FAILED_TEXT };
    } finally {
      guess.saving = false;
    }
  }
  return {};
}

async function saveGuess(guess: WasteGuess, deps: WasteActionDeps): Promise<SavedEntry[]> {
  // The photo and the run are written once; a retry after a failed save reuses them.
  if (guess.photo && !guess.photoPath) {
    guess.photoPath = await deps.photos.save(
      photoPath(guess.outletId, guess.id, guess.photo.mediaType),
      guess.photo.data,
    );
  }
  if (guess.runId) {
    // A retry: if the earlier log_waste committed but its reply was lost, do not log again.
    const logged = await entriesOfRun(deps.db, guess.runId);
    if (logged.length > 0) return finishSave(guess, deps, logged);
  } else {
    const [run] = await deps.db
      .insert(agentRuns)
      .values({
        agent: "copilot",
        trigger: "telegram",
        traceId: guess.traceId ?? null,
        instructionsVersion: COPILOT_INSTRUCTIONS_VERSION,
      })
      .returning({ id: agentRuns.id });
    guess.runId = run!.id;
  }

  // One call for every line: kitchen-mcp saves them all or none.
  const { entries } = await callMcpTool<{ entries: SavedEntry[] }>(deps.servers, "log_waste", {
    outlet_id: guess.outletId,
    lines: guess.lines.map((line) =>
      line.weightKg !== undefined
        ? { item_id: line.item.id, weight_kg: line.weightKg }
        : { item_id: line.item.id, portion_count: line.portionCount },
    ),
    cause: guess.cause,
    source: guess.source,
    ...(guess.photoPath ? { photo_path: guess.photoPath } : {}),
    ...(guess.confidence !== undefined ? { confidence: guess.confidence } : {}),
    confirmed_by: guess.userId,
    run_id: guess.runId,
    logged_at: guess.loggedAt,
  });

  return finishSave(guess, deps, entries);
}

async function entriesOfRun(db: Db, runId: string): Promise<SavedEntry[]> {
  const rows = await db
    .select({
      id: wasteEntries.id,
      item_name: menuItems.name,
      weight_kg: wasteEntries.weightKg,
      portion_count: wasteEntries.portionCount,
      cause: wasteEntries.cause,
    })
    .from(wasteEntries)
    .innerJoin(menuItems, eq(menuItems.id, wasteEntries.itemId))
    .where(eq(wasteEntries.runId, runId))
    .orderBy(asc(wasteEntries.loggedAt));
  return rows.map((r) => ({ ...r, weight_kg: Number(r.weight_kg) }));
}

/** Marks the run succeeded and scores the confirmation. */
async function finishSave(
  guess: WasteGuess,
  deps: WasteActionDeps,
  entries: SavedEntry[],
): Promise<SavedEntry[]> {
  await deps.db
    .update(agentRuns)
    .set({ status: "succeeded" })
    .where(eq(agentRuns.id, guess.runId!));
  if (guess.traceId) {
    const fields = changedFields(guess.original, snapshot(guess));
    const accepted = !guess.original.unsure && fields.length === 0;
    await sendScore(deps.scorer, deps.log, {
      traceId: guess.traceId,
      name: "waste_guess_accepted",
      value: accepted ? 1 : 0,
      metadata: { fields, unsure: guess.original.unsure, lines: guess.lines.length },
    });
  }
  return entries;
}
