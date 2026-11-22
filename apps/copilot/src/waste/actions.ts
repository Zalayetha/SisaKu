import type { McpServer } from "@anvia/core/mcp";
import { callMcpTool } from "@sisaku/agents";
import { agentRuns, WASTE_CAUSES } from "@sisaku/db";
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
  if (!guess) return { edit: { text: "Draft kedaluwarsa." }, reply: EXPIRED_TEXT };
  if (guess.userId !== input.userId) return { reply: NOT_YOURS_TEXT };
  guess.cardMessageId = input.messageId;

  const { code } = input;
  if (code === "x") {
    deps.store.delete(guess.id);
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
    // Remove first, so a double tap cannot save twice.
    deps.store.delete(guess.id);
    const entries = await saveGuess(guess, deps);
    return { edit: savedCard(guess, entries) };
  }
  return {};
}

async function saveGuess(guess: WasteGuess, deps: WasteActionDeps): Promise<SavedEntry[]> {
  const path = guess.photo
    ? await deps.photos.save(
        photoPath(guess.outletId, guess.id, guess.photo.mediaType),
        guess.photo.data,
      )
    : undefined;
  const [run] = await deps.db
    .insert(agentRuns)
    .values({
      agent: "copilot",
      trigger: "telegram",
      status: "succeeded",
      traceId: guess.traceId ?? null,
    })
    .returning({ id: agentRuns.id });

  const entries: SavedEntry[] = [];
  for (const line of guess.lines) {
    const { entry } = await callMcpTool<{ entry: SavedEntry }>(deps.servers, "log_waste", {
      outlet_id: guess.outletId,
      item_id: line.item.id,
      cause: guess.cause,
      source: guess.source,
      ...(line.weightKg !== undefined
        ? { weight_kg: line.weightKg }
        : { portion_count: line.portionCount }),
      ...(path ? { photo_path: path } : {}),
      ...(guess.confidence !== undefined ? { confidence: guess.confidence } : {}),
      confirmed_by: guess.userId,
      run_id: run!.id,
      logged_at: guess.loggedAt,
    });
    entries.push(entry);
  }

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
