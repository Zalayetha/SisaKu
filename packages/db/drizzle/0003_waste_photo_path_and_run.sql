ALTER TABLE "waste_entries" RENAME COLUMN "photo_url" TO "photo_path";--> statement-breakpoint
ALTER TABLE "waste_entries" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "waste_entries" ADD CONSTRAINT "waste_entries_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;
