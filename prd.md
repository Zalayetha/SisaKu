# Sisaku — Product Requirements

Nov 14, 2026 · @Zaghy

## Overview

Sisaku tells commercial kitchens how much to cook tomorrow, so less food ends up in the bin. Staff log waste from a Telegram photo, and agents turn sales and waste data into daily prep recommendations, surplus donations and a report of the Rupiah and CO₂e saved.

**Problem.** Restaurants, hotels and caterers set prep quantities by gut feel. Nobody connects what was sold, what was prepped and what was thrown away, so over-prep repeats every day. Waste is a direct cost leak that is almost never measured.

**Why an agent system, not a chatbot.** The main value comes from a pipeline that runs every night without being asked. It pulls data through tools, decides what changed and why, and acts by writing prep recommendations and drafting donation requests. A conversational agent on Telegram handles logging and questions.

**Scope.** A final-assignment MVP for the Sustainability Intelligence theme, built in two weeks on mock data for two restaurants. It covers the full loop: log, analyze, forecast, recommend, report. How it is built is in the technical design doc.

## Background and evidence

Indonesia wastes 23–48 million tons of food a year, worth Rp 213–551 trillion, or 4–5% of GDP, according to Bappenas's study of 2000–2019 ([Databoks](https://databoks.katadata.co.id/en/economics-macro/statistics/66daabbd07695/massive-food-waste-in-indonesia-value-exceeds-rp-200-trillion-annually)). The government has written a 3–5% yearly reduction and food rescue target into the 2025–2029 national development plan ([Investortrust](https://investortrust.id/esg/118868/indonesia-faces-34-billion-economic-drain-as-annual-food-waste-reaches-48-million-tons)).

Hotels, restaurants and caterers are the second-largest source after households, per Bappenas data cited by Hindayani et al. (2025). That makes commercial kitchens a concentrated, reachable target: one kitchen manager decides prep for hundreds of portions a day.

**What the research says**

| Paper | Setting | Finding relevant to Sisaku |
| --- | --- | --- |
| [Hasna et al. (2026)](https://ejournal.uin-suska.ac.id/index.php/jti/article/download/39625/13867), Jurnal Teknik Industri 12(1) | Sheraton Grand Jakarta buffet | Occupancy-based forecasting, batch cooking, waste logs and surplus donation cut monthly waste from 44,123 kg (July) to 29,253 kg (September 2025) |
| [Syaiful et al. (2026)](https://jurnal.btp.ac.id/index.php/manner-btp/article/download/565/381/2553), Jurnal Manner 5(2) | Restaurant literature review | Weak demand forecasting leading to over-production is the most dominant operational cause of restaurant waste |
| [Sadyasmara et al. (2025)](https://www.bio-conferences.org/10.1051/bioconf/202518604002), BIO Web of Conferences 186 | Bali hotels and restaurants | Hotels average about 2,137 kg and restaurants about 1,635 kg of food waste per month |
| [Hindayani et al. (2025)](https://ejournal.upi.edu/index.php/gastur/article/download/83291/pdf), Journal Gastronomy Tourism 12(1) | Indonesian HoReCa, 222 publications | HoReCa ranks second in food waste after households |
| [Kattiyapornpong et al. (2023)](https://www.mdpi.com/2071-1050/15/13/10213/pdf), Sustainability 15(13) | Five-star hotels, Thailand | Hospitality food waste research is mostly done in developed countries and lacks managerial solutions |
| [Srijuntrapun & Sukwong (2024)](https://ph01.tci-thaijo.org/index.php/aer/article/download/257561/173953/994558), Applied Environmental Research 46(4) | Hotel catering, Bangkok | Dinner-style buffets produce the most food waste of four catering styles |

**Gap.** The Indonesian studies show forecasting and logging work, but they are manual and done in large hotels. No paper we found applies agent-based forecasting to mid-size Indonesian or Southeast Asian kitchens. Sisaku targets that gap.

## Goals, non-goals and success metrics

The MVP succeeds if the nightly pipeline produces prep recommendations that beat a naive baseline, and every number in a report traces back to data.

**Goals**

- Log waste in under 30 seconds from a Telegram photo or a short text message
- Forecast next-day demand per menu item and turn it into prep quantities, each with a reason
- Explain waste by item and cause (over-prep, spoilage, plate waste, prep error)
- Produce a daily brief and a weekly report covering Rupiah wasted, kg wasted and CO₂e
- Stretch: flag donatable surplus and draft a pickup request to a food bank

**Non-goals (MVP)**

- Real cashier (point-of-sale) system integrations: mock data and CSV upload only
- Smart scales or other hardware
- Inventory and purchasing management
- Certified ESG or greenhouse gas reporting

**Success metrics**

| Metric | Target | How it's measured |
| --- | --- | --- |
| Forecast accuracy | Mean absolute percentage error at least 15% lower than "same weekday last week" | Backtest on 14 held-out days |
| Simulated waste reduction (stretch) | 20% less over-prep on held-out days | Replay history with recommended prep |
| Report faithfulness | 100% of numbers match the database | Deterministic check |
| Logging time | Under 30 seconds per entry | Timed in the demo |
| Photo classification (stretch) | 80% correct item category | 40 labeled photos |

**Honest note on mock data.** We generate the sales data ourselves, so we also control how hard it is to forecast. To keep the forecast metric meaningful, the generator adds noise, holidays and surprise spikes the forecaster isn't told about. If time allows, we also backtest on a public restaurant sales dataset. The demo will say clearly that the data is simulated.

## Users and user stories

The primary user is the kitchen manager who decides prep quantities every day. The owner reads the reports, and line staff only log waste.

| Persona | Context | Main need |
| --- | --- | --- |
| Kitchen manager (Rina) | Mid-size restaurant, plans prep each morning | Know how much to prep, and why waste happened |
| Owner (Pak Budi) | Runs 2–3 outlets, watches margins | See Rupiah lost and the trend week over week |
| Line staff (Dimas) | Clears bins at closing | Log waste quickly without forms |
| Food bank coordinator | Collects surplus | Clear, timely pickup requests |

**User stories**

1. As line staff, I send a photo of the waste bin on Telegram and the bot logs items and estimated weight, so I don't fill in forms.
2. As a kitchen manager, I get a morning brief with recommended prep per item and a reason for each change.
3. As a kitchen manager, I ask "why did rendang waste spike this week?" and get an answer backed by data and a chart.
4. As an owner, I get a weekly report with Rupiah wasted, kg wasted, CO₂e and the top 5 items to fix.
5. As a kitchen manager, I correct a wrong entry, and the correction is used to improve the system.
6. Stretch: as a kitchen manager, I approve or reject a drafted food bank pickup in one tap.

## Features and acceptance criteria

Five features are must-have (P0) for the demo; two are stretch (P1) and get cut first if time runs short.

| # | Feature | Priority | Done when |
| --- | --- | --- | --- |
| F1 | Waste logging on Telegram | P0 | A photo or text message creates a waste entry with item, cause and weight in kg; the bot shows its guess and the user confirms or edits it; low-confidence guesses always ask for confirmation |
| F2 | Data import | P0 | Mock sales, prep logs and menu (with cost and weight per portion) load from CSV; a script generates 60 days for 2 outlets |
| F3 | Demand forecast and prep recommendation | P0 | Every night, each menu item gets a prep quantity, a confidence and a one-line reason; any change from the plain forecast states why |
| F4 | Waste analysis | P0 | Waste is grouped by item, cause and day; an item with more than double its 14-day average waste is flagged and the agent explains the likely cause |
| F5 | Reports | P0 | The manager gets a daily brief on Telegram; the owner gets a weekly report with Rupiah, kg and CO₂e; every number matches the database |
| F6 | Surplus routing | P1 | Donatable surplus is checked against food-safety rules and a pickup request is drafted; nothing is sent without manager approval |
| F7 | Dashboard | P1 | A read-only web page shows waste trends, forecast versus actual, and recent agent runs |

**Human in the loop.** Agents never send anything outside the app on their own. Donation requests, and prep changes larger than 30%, need manager approval.

## Demo scenario

The demo tells one day in the life of Warung Rina, a mock restaurant, in about five minutes.

1. **Closing time (1 min).** Dimas sends a photo of the waste bin on Telegram. The bot replies "About 1.5 kg rendang, 0.8 kg rice, cause: over-prep?" and he confirms.
2. **Nightly run (1 min).** We trigger the pipeline and show its trace in Anvia Lens: it pulls the day's data, flags that rendang waste is more than double its average, investigates, and finds Friday sales dropped because of a long weekend.
3. **Morning brief (1 min).** Rina receives "Rendang: prep 40 portions (usually 50), long weekend, confidence 0.7" and approves it.
4. **Asking why (1 min).** Rina asks "why is rendang waste high this week?" and the Copilot answers with numbers and a chart.
5. **Weekly report and evals (1 min).** We show the owner's report with Rupiah and CO₂e, then the eval results: forecast error against baseline and report faithfulness.

## Rubric fit, risks and decisions

Every assignment requirement maps to a concrete part of Sisaku; the technical design doc has the details.

| Requirement | Where it's covered |
| --- | --- |
| PRD before coding | This document and the technical design |
| Agents with tools | Both agents reach all data through tools |
| MCP | Two custom MCP servers (kitchen-mcp, impact-mcp) |
| RAG | Food-safety donation rules, emission notes, kitchen recipes, past reports |
| Evals | Four core eval suites, two stretch |
| Observability | Anvia Lens traces, cost and latency |
| 1 agentic + 1 AI agent | Nightly pipeline (agentic) + Kitchen Copilot on Telegram (AI agent) |
| Interface agnostic | Telegram, web dashboard, any MCP client |
| Anvia ecosystem | Anvia SDK, Studio, Lens, Channel and Hammer |

**Risks**

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Scope too big for two weeks | Unfinished demo | P0 covers the full loop; surplus routing and dashboard are cut first |
| Mock data looks too clean | Forecasts look fake | Noise, holidays and surprise spikes in the generator |
| Photo weight guesses are wrong | Wrong kg, Rupiah and CO₂e | User always confirms; portion count and typed weight as better options |
| LLM adjustment makes forecasts worse | Higher error than baseline | Plain forecast is the floor; evals decide whether the adjustment stays |

**Decisions**

- Emission factors: Our World in Data (Poore & Nemecek, 2018) for producing the food, plus IPCC 2006 Volume 5 defaults for landfill methane. Reported as an estimate.

## Sources

Related: Sisaku — Technical Design

- [Databoks: Indonesia food waste value exceeds Rp 200 trillion annually](https://databoks.katadata.co.id/en/economics-macro/statistics/66daabbd07695/massive-food-waste-in-indonesia-value-exceeds-rp-200-trillion-annually)
- [Investortrust: Indonesia faces $34 billion economic drain as food waste reaches 48 million tons](https://investortrust.id/esg/118868/indonesia-faces-34-billion-economic-drain-as-annual-food-waste-reaches-48-million-tons)
- [Hasna et al. (2026), Zero food waste in buffet service, Sheraton Grand Jakarta](https://ejournal.uin-suska.ac.id/index.php/jti/article/download/39625/13867)
- [Syaiful et al. (2026), Food waste management in restaurant businesses](https://jurnal.btp.ac.id/index.php/manner-btp/article/download/565/381/2553)
- [Sadyasmara et al. (2025), Food waste from hotels and restaurants in Bali](https://www.bio-conferences.org/10.1051/bioconf/202518604002)
- [Hindayani et al. (2025), Food waste within Indonesia's HoReCa industry](https://ejournal.upi.edu/index.php/gastur/article/download/83291/pdf)
- [Kattiyapornpong et al. (2023), Sustainable food waste management in five-star hotels in Thailand](https://www.mdpi.com/2071-1050/15/13/10213/pdf)
- [Srijuntrapun & Sukwong (2024), Food waste from catering services in Thai hotels](https://ph01.tci-thaijo.org/index.php/aer/article/download/257561/173953/994558)
- [Poore & Nemecek (2018), Reducing food's environmental impacts through producers and consumers, Science 360(6392)](https://ora.ox.ac.uk/objects/pubs:854765)
- [Our World in Data: Greenhouse gas emissions per kilogram of food product](https://ourworldindata.org/grapher/ghg-per-kg-poore)
- [IPCC 2019 Refinement to the 2006 Guidelines, Volume 5, Chapter 3: Solid Waste Disposal](https://www.ipcc-nggip.iges.or.jp/public/2019rf/pdf/5_Volume5/19R_V5_3_Ch03_SWDS.pdf)
