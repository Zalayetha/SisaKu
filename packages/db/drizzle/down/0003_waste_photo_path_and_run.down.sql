ALTER TABLE "waste_entries" DROP CONSTRAINT "waste_entries_run_id_agent_runs_id_fk";
ALTER TABLE "waste_entries" DROP COLUMN "run_id";
ALTER TABLE "waste_entries" RENAME COLUMN "photo_path" TO "photo_url";
