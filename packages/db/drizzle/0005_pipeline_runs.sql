CREATE TYPE "public"."pipeline_job_status" AS ENUM('pending', 'running', 'succeeded', 'degraded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."pipeline_step" AS ENUM('ingest', 'analyze', 'forecast', 'recommend', 'report');--> statement-breakpoint
CREATE TABLE "pipeline_job_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"output" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_job_results_job_id_unique" UNIQUE("job_id")
);
--> statement-breakpoint
CREATE TABLE "pipeline_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"step" "pipeline_step" NOT NULL,
	"status" "pipeline_job_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "pipeline_jobs_run_id_step_unique" UNIQUE("run_id","step")
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "outlet_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "business_date" date;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "pipeline_job_results" ADD CONSTRAINT "pipeline_job_results_job_id_pipeline_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."pipeline_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_jobs" ADD CONSTRAINT "pipeline_jobs_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_scheduled_pipeline_run_unique" ON "agent_runs" USING btree ("outlet_id","business_date") WHERE "agent_runs"."agent" = 'nightly-pipeline' and "agent_runs"."trigger" = 'schedule';