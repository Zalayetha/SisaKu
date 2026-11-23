/**
 * The Kitchen Copilot's tool allowlist (ADR 0012). Deny by default: an MCP tool that is not
 * listed here never reaches the model, so a tool added to a server later stays hidden until
 * someone adds it on purpose.
 *
 * `log_waste` is never listed: only fixed code calls it, after a confirmation (ADR 0014).
 * `draft_pickup` belongs to the nightly pipeline and is never listed here. Planned addition:
 * `submit_pickup` (with the approval handler).
 */
export const COPILOT_TOOL_ALLOWLIST = [
  "get_menu",
  "get_sales",
  "get_prep_log",
  "query_waste",
  "get_factor",
  "compute_co2e",
  "update_entry",
] as const;

export type CopilotToolName = (typeof COPILOT_TOOL_ALLOWLIST)[number];
