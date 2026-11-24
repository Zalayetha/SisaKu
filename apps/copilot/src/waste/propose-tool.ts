import { randomUUID } from "node:crypto";
import { createTool } from "@anvia/core";
import { MAX_WASTE_WEIGHT_KG, WASTE_CAUSES } from "@sisaku/db";
import { z } from "zod";
import {
  isUnsure,
  MAX_CANDIDATES,
  MAX_LINES,
  snapshot,
  type GuessLine,
  type GuessStore,
  type MenuItem,
  type WasteGuess,
} from "./guess";

export const PROPOSE_TOOL_NAME = "propose_waste_entry";

/** What one chat turn knows when the model proposes a waste guess. */
export type ProposeContext = {
  user: { id: string; outletId: string; timezone: string };
  chatId: string;
  /** When the message arrived; the default waste time. */
  messageTime: Date;
  photo?: { data: Buffer; mediaType: string } | undefined;
  store: GuessStore;
  /** The outlet's menu, read once per turn. */
  menu: readonly MenuItem[];
  /** Filled in by the tool: the guess to show after this turn, and the older one it replaces. */
  turn: { guess?: WasteGuess; replaced?: WasteGuess };
};

const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export const proposeInput = z.object({
  lines: z
    .array(
      z.object({
        item_id: z.string().describe("Menu item id from the menu in your instructions"),
        portion_count: z.number().int().positive().max(10000).optional(),
        weight_kg: z
          .number()
          .positive()
          .max(MAX_WASTE_WEIGHT_KG)
          .optional()
          .describe("Only when the user typed a weight; never estimated from a photo"),
      }),
    )
    .max(MAX_LINES)
    .optional()
    .describe("One line per distinct menu item, each with portion_count or weight_kg"),
  candidate_item_ids: z
    .array(z.string())
    .max(MAX_CANDIDATES)
    .optional()
    .describe("For a photo with confidence below 0.6: up to 3 likely menu item ids"),
  cause: z.enum(WASTE_CAUSES).optional().describe("Only if the user stated or implied it"),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("For a photo: how sure you are of the items and portions, 0 to 1"),
  corrects_open_guess: z
    .boolean()
    .optional()
    .describe("true when the user's message corrects the open waste guess; it is then replaced"),
  logged_at: z.iso
    .datetime({ offset: true })
    .optional()
    .describe("When the waste happened, only if the user named a time; defaults to now"),
});

type Result = { ok: true; shown_to_user: true; note: string } | { ok: false; error: string };

const fail = (error: string): Result => ({ ok: false, error });

/**
 * The model's only way to log waste: it stores a waste guess and the turn shows its card. Saving
 * happens later, in fixed code, when the user taps Simpan (ADR 0014).
 */
export function createProposeWasteTool(ctx: ProposeContext) {
  return createTool({
    name: PROPOSE_TOOL_NAME,
    description:
      "Show the user a waste guess (menu items with portions, cause, time) as a card with Simpan / Ubah / Batal buttons. Nothing is saved until the user taps Simpan. Item ids come from the menu in your instructions.",
    inputSchema: proposeInput,
    async handler(args): Promise<Result> {
      const byId = new Map(ctx.menu.map((m) => [m.id, m]));

      const lines: GuessLine[] = [];
      for (const line of args.lines ?? []) {
        const item = byId.get(line.item_id);
        if (!item) return fail(`item_id ${line.item_id} is not on this outlet's menu`);
        if ((line.portion_count === undefined) === (line.weight_kg === undefined)) {
          return fail("each line needs exactly one of portion_count or weight_kg");
        }
        // log_waste would reject this line on Simpan, so refuse it now instead.
        // Rounded to grams, as kitchen-mcp stores and checks it.
        const kg =
          Math.round((line.weight_kg ?? line.portion_count! * item.portionWeightKg) * 1000) / 1000;
        if (kg > MAX_WASTE_WEIGHT_KG) {
          return fail(
            `${item.name}: ${kg} kg is more than one entry can hold (${MAX_WASTE_WEIGHT_KG} kg)`,
          );
        }
        lines.push(
          line.portion_count !== undefined
            ? { item, portionCount: line.portion_count }
            : { item, weightKg: line.weight_kg! },
        );
      }
      const candidates: MenuItem[] = [];
      for (const id of args.candidate_item_ids ?? []) {
        const item = byId.get(id);
        if (!item) return fail(`candidate ${id} is not on this outlet's menu`);
        candidates.push(item);
      }

      let loggedAt = ctx.messageTime.toISOString();
      if (args.logged_at) {
        if (Date.parse(args.logged_at) > ctx.messageTime.getTime() + FUTURE_TOLERANCE_MS) {
          return fail("logged_at is in the future");
        }
        loggedAt = new Date(args.logged_at).toISOString();
      }

      // A text message may correct the chat's open guess; a new photo always starts a new one.
      const correcting = args.corrects_open_guess === true && !ctx.photo;
      const base = ctx.turn.guess ?? (correcting ? ctx.store.openIn(ctx.chatId) : undefined);
      // Without an open guess there is nothing to replace: a new guess would be saved next to the
      // entry the user wants corrected (ADR 0014).
      if (correcting && !base) {
        return fail(
          "There is no open waste guess to correct. If the user is correcting saved waste, find it with list_entries and use update_entry.",
        );
      }
      const fromPhoto = base ? base.source === "photo" : ctx.photo !== undefined;
      const confidence = fromPhoto ? (base?.confidence ?? args.confidence ?? 0) : undefined;
      // Any correction typed by the user counts as supplied by a person.
      const userSupplied = base !== undefined && !ctx.photo;

      const draft = { lines, cause: args.cause ?? base?.cause, loggedAt, userSupplied, confidence };
      if (!isUnsure(draft) && lines.length === 0) {
        return fail("give at least one line, or candidate_item_ids for an unsure photo");
      }
      if (isUnsure(draft) && candidates.length === 0) {
        candidates.push(...lines.map((l) => l.item).slice(0, MAX_CANDIDATES));
      }

      const guess: WasteGuess = {
        id: randomUUID(),
        userId: ctx.user.id,
        outletId: ctx.user.outletId,
        chatId: ctx.chatId,
        timezone: ctx.user.timezone,
        source: fromPhoto ? "photo" : "text",
        photo: base ? base.photo : ctx.photo,
        // A failed Simpan's photo and run carry over, so saving the correction reuses them and
        // finds entries the failed save may have committed (ADR 0014).
        photoPath: base?.photoPath,
        runId: base?.runId,
        confidence,
        userSupplied,
        candidates,
        lines,
        cause: draft.cause,
        loggedAt,
        original: base ? base.original : snapshot(draft),
        createdAtMs: ctx.messageTime.getTime(),
      };
      if (base) {
        if (base === ctx.turn.guess) ctx.store.delete(base.id);
        else {
          ctx.store.settle(base.id, "replaced");
          ctx.turn.replaced = base;
        }
      }
      ctx.store.add(guess);
      ctx.turn.guess = guess;
      return {
        ok: true,
        shown_to_user: true,
        note: "The card with buttons is sent to the user. Reply with at most one short sentence.",
      };
    },
  });
}
