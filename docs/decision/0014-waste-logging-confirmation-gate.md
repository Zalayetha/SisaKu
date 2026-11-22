# 0014: Waste logging confirmation gate

- Date: 2026-11-22
- Status: accepted

## Context

ZALS-16 lets staff log waste in the Kitchen Copilot by sending a photo or a text. A photo's item and portion count are guesses, and the acceptance criterion is that a guess below 0.6 confidence is never logged without the user confirming it or typing the item and portion count. ADR 0012 planned to give the model `log_waste` and `update_entry`, and left the store for pending confirmations to this issue. Corrections must also become eval feedback (technical design). The decisions were grilled in the ZALS-16 session of 2026-11-22.

## Decision

**The model proposes, fixed code saves**

- The model never sees `log_waste`. It calls a local tool, `propose_waste_entry`, which stores a waste guess and sends a card with **Simpan / Ubah / Batal** buttons (Anvia Channel actions). Only a tap on Simpan by the user who created the guess makes fixed code call `log_waste`, with `outlet_id` and `confirmed_by` taken from the looked-up user. A prompt cannot log waste without a confirmation, whatever it says.
- Every waste guess needs a confirmation, whatever its confidence. The threshold changes the card: at 0.6 or higher it shows the guess with a one-tap Simpan; below 0.6 it says the bot is unsure, offers up to three likely menu items, and shows no Simpan until the user has supplied the item and portion count.
- Without a stated cause the card asks for one of the five causes; there is no default, so cause reports are not skewed.
- `update_entry` stays a model tool for corrections to saved entries, open to any user of the outlet for the MVP.

**What a waste guess holds**

- One guess comes from one photo or text and has up to five lines, each a menu item with a portion count or a typed weight. Photos never produce a weight. A mixed dish that is one menu item is one line; different menu items in one bin are separate lines. One Simpan saves one waste entry per line, sharing the cause and photo, in a single `log_waste` call that saves every line or none. The largest weight one entry can hold is checked when the guess is proposed, so a card does not offer an amount `log_waste` would reject.
- The same Copilot agent reads the photo (as image input) and the text; confidence is the model's own estimate. A separate structured vision step can replace this later without changing the gate.
- `logged_at` is the message time unless the text names another time. Items that are not on the menu are not guessed.
- A text message replaces the chat's open guess only when the model marks its proposal as a correction (`corrects_open_guess`); otherwise it starts a new guess, so a separate report never inherits another guess's photo. A replaced card is edited to say so and its buttons stop working.

**Drafts and photos**

- Waste guesses live in memory, keyed by a guess id carried in the action id (`w:<guessId>:<action>`, within Telegram's 64-byte limit). They expire after 30 minutes and are lost on restart, like chat history. A tap on an expired guess asks the user to send it again.
- A guess stays open until its save succeeds. While a save runs, further taps are ignored; if it fails, nothing was logged and the user can tap Simpan again, reusing the photo and `agent_runs` row already written. A retry first looks for entries already linked to that run, so a save whose reply was lost is not logged twice; the run is marked succeeded only once its entries exist. A correction made after a failed Simpan keeps that photo and run, so saving it also finds entries the failed save may have committed; the card then shows what was actually stored, to be fixed through `update_entry`. Saved, cancelled and replaced guesses are remembered for 30 minutes, so a late tap on their card answers "sudah tersimpan / dibatalkan / diganti" and leaves the card's text alone.
- Photo bytes (Telegram photos and image files up to 10 MB) stay with the guess and are written to the photos volume (ADR 0010) as `<outlet_id>/<guessId>.jpg` only on Simpan, so cancelled guesses leave nothing on disk.

**Feedback**

- On Simpan, fixed code writes an `agent_runs` row (`agent=copilot`, `trigger=telegram`, the Lens `trace_id`), and each new waste entry points to it through a nullable `waste_entries.run_id`.
- A Lens score `waste_guess_accepted` (1 unchanged, 0 edited) is attached to that trace with the names of the changed fields. A later `update_entry` attaches `waste_entry_corrected` to the trace of the run that logged the entry. Only field names are sent, never values, so Lens stays in safe capture mode (ADR 0012).

## Consequences

- The low-confidence rule is enforced by code and can be tested without a model: a guess below 0.6 has no Simpan button and cannot be saved.
- `log_waste` is used by fixed code, not by the model, so the allowlist test must show `update_entry` exposed and `log_waste` hidden. ADR 0012's planned allowlist is amended accordingly.
- A restart between guess and tap loses the guess; the user sends it again. Move guesses to a persistent store if that happens often.
- Confidence is self-reported by the model; the photo eval (ZALS-24) must check its calibration before the threshold is trusted.
- `waste_entries` gains `run_id`, and `photo_url` is renamed `photo_path` (ZALS-13 notes), each with a hand-written down migration (ADR 0005).
