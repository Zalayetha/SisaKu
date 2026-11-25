DROP TABLE "pipeline_job_results";
DROP TABLE "pipeline_jobs";
DROP INDEX "agent_runs_scheduled_pipeline_run_unique";
ALTER TABLE "agent_runs" DROP COLUMN "outlet_id";
ALTER TABLE "agent_runs" DROP COLUMN "business_date";
ALTER TABLE "agent_runs" DROP COLUMN "finished_at";
ALTER TABLE "agent_runs" DROP COLUMN "error";
DROP TYPE "pipeline_job_status";
DROP TYPE "pipeline_step";
