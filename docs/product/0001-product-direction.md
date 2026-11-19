# 0001: Product direction

- Date: 2026-11-19

## Product decision

SisaKu tells commercial kitchens how much to cook tomorrow so less food is binned. Staff log waste from a Telegram photo, and agents turn sales and waste data into nightly prep recommendations, surplus donation drafts, and a report of Rupiah and CO₂e saved.

The MVP is a final-assignment prototype built on mock data for two outlets, labeled as simulated in the demo.

- **In scope (P0):** Telegram waste logging, mock data import (60 days, two outlets), forecast and prep recommendation, waste analysis, daily brief and weekly report.
- **P1, cut first:** surplus routing to food banks.
- **Out of scope:** real POS integration, hardware, inventory and purchasing, certified ESG reporting, a web dashboard, and any channel other than Telegram.

Nothing leaves the app without a person's approval. Donation requests and prep changes over 30% need sign-off.

Source documents: `prd.md` (what and why) and `technical-design.md` (how).

## Notes

- Success metrics from the PRD: forecast MAPE at least 15% lower than "same weekday last week" on 14 held-out days, 100% of report numbers matching the database, and under 30 seconds per waste log entry.
- Weather for the forecast comes from the Open-Meteo MCP server, which needs no API key.
- Open question: none recorded here yet. Record decisions under **Product decision** when they are agreed.
