# 0011: impact-mcp approval boundary and CO₂e method

- Date: 2026-11-21
- Status: accepted

## Context

`impact-mcp` (ZALS-14, spec ZALS-34) gives agents emission factors, CO₂e for logged waste, and a food bank pickup stub. Two choices are hard to reverse and would surprise a reader:

- **Approval.** The product rule is that nothing leaves the app without a person's approval, and the Safety and approval eval (technical design, Core) requires that an agent never submits a pickup without it. `submit_pickup` needs an approved request, but something must record the approval.
- **CO₂e.** `technical-design.md` gives the formula (weight × (Our World in Data production factor + IPCC landfill factor, 0.15 kg degradable carbon per kg)) but not the remaining IPCC parameters, the category mapping, or where the computation runs.

The numbers were chosen with a throwaway prototype (branch `prototype/zals-14-co2e-factors`, never merged); the decision and the hand check are in the ZALS-14 comment of 2026-11-21.

## Decision

**Approval boundary**

- impact-mcp has no tool that approves or rejects. A manager or owner approves outside MCP, through fixed code (the Telegram approval handler, a later issue) that writes `status` and `approved_by` through `@sisaku/db`. Agents can draft and submit, never approve.
- `draft_pickup` records a request as `pending`. `submit_pickup(outlet_id, id)` moves `approved` → `submitted` in one conditional `UPDATE`: the request must belong to the outlet, be `approved`, and have an `approved_by` who is a `manager` or `owner` of that outlet. Everything else is refused with the reason, including a second submit. `submitted` only records the request; nothing contacts a food bank.
- `draft` stays in the `pickup_status` enum, reserved and unused.
- Pickup items are `[{ item_id, portion_count }]` from the outlet's menu. Food banks are a fictional mock list. Deciding what surplus is donatable is out of scope (surplus routing is P1, cut first).

**CO₂e method**

- Per kg of waste, CO₂e = weight × (production factor + landfill factor) of the menu item's food category.
- **Production factors**: Our World in Data, `ghg-per-kg-poore` (Poore & Nemecek 2018, data year 2010, fetched 2026-11-21), per kg of raw product. Mapping: rice → Rice 4.45, beef → Beef (beef herd) 99.48, chicken → Poultry Meat 9.87, fish → Fish (farmed) 13.63, eggs → Eggs 4.67, soy → Tofu 3.16, vegetables → Other Vegetables 0.53, fruit → Other Fruit 1.05.
- **Landfill factor**: 1.134 kg CO₂e per kg, the same for every category, counted once as the total the waste will eventually emit:
  DOC 0.15 × DOCf 0.7 × MCF 0.6 × F 0.5 × 16/12 × (1 − OX 0) = 0.042 kg CH₄, × GWP₁₀₀ 27.0 = 1.134.
  DOC: IPCC 2006 Vol 5 Ch 2 Table 2.4 (food waste). DOCf 0.7 (food waste), MCF 0.6 (uncategorised site), F 0.5, OX 0: IPCC 2019 Refinement Vol 5 Ch 3 (Tables 3.0, 3.1, 3.2; Eq 3.1–3.3, 3.6). GWP₁₀₀ 27.0: IPCC AR6 WG1 Table 7.15, non-fossil CH₄. MCF 0.6 rather than 1.0 because most Indonesian waste goes to unmanaged dumps.
- **No cooked-weight correction.** Factors are per raw kg but waste is cooked weight, so starchy foods (rice) read high. Every result carries a note that CO₂e is an estimate.
- **Computed in SQL.** `compute_co2e` takes the same filters as `query_waste` (outlet, outlet-local days, optional item and cause) and joins waste entries → menu items → emission factors. It returns totals, a breakdown per food category with sources, and `uncovered` waste whose category has no factor (counted in kg, not in CO₂e). The LLM never passes weights in, so report numbers match the database (as in ADR 0009). This replaces `compute_co2e(entries)` in the technical design.
- **Factors are data.** They live in `packages/db/seed/emission_factors.csv`, one row per category with its sources, loaded by `pnpm db:import-csv` (`emission_factors` is a CSV table, upserted by `food_category`, factors must be positive).

## Consequences

- The "no submit without approval" guarantee holds even if a prompt tricks the agent: the server refuses. The approval handler and the agent's tool allowlist must be built before pickups work end to end.
- Changing a factor is a CSV edit and a re-import; no code change. The hand check (0.36 kg rendang + 1.0 kg nasi = 41.81 kg CO₂e) is a test against the committed CSV, so a change to beef or rice values shows up there.
- CO₂e is not Indonesia-specific and not certified; reports must say "estimate".
- A menu item whose `food_category` has no row is reported as uncovered instead of failing; adding the row fixes it.
- Package layout, errors, transports and outlet scope follow ADR 0009. HTTP uses `IMPACT_MCP_TOKEN` and `IMPACT_MCP_PORT` (default 3002).
