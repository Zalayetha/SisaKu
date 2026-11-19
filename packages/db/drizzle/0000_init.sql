CREATE TYPE "public"."agent_run_status" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."pickup_status" AS ENUM('draft', 'pending', 'approved', 'rejected', 'submitted');--> statement-breakpoint
CREATE TYPE "public"."recommendation_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('staff', 'manager', 'owner');--> statement-breakpoint
CREATE TYPE "public"."waste_source" AS ENUM('photo', 'text');--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent" text NOT NULL,
	"trigger" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "agent_run_status" DEFAULT 'running' NOT NULL,
	"trace_id" text,
	"cost_usd" numeric(10, 4)
);
--> statement-breakpoint
CREATE TABLE "emission_factors" (
	"food_category" text PRIMARY KEY NOT NULL,
	"production_kg_co2e_per_kg" double precision NOT NULL,
	"landfill_kg_co2e_per_kg" double precision NOT NULL,
	"source" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forecasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"date" date NOT NULL,
	"baseline_qty" double precision NOT NULL,
	"adjusted_qty" double precision,
	"reason" text,
	"model" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "menu_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outlet_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"cost_per_portion" numeric(12, 2) NOT NULL,
	"portion_weight_kg" numeric(8, 3) NOT NULL,
	"food_category" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outlets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"location" text,
	"timezone" text DEFAULT 'Asia/Jakarta' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pickup_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outlet_id" uuid NOT NULL,
	"foodbank_id" text NOT NULL,
	"items" jsonb NOT NULL,
	"status" "pickup_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" uuid
);
--> statement-breakpoint
CREATE TABLE "prep_logs" (
	"outlet_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"date" date NOT NULL,
	"qty_prepped" integer NOT NULL,
	CONSTRAINT "prep_logs_outlet_id_item_id_date_pk" PRIMARY KEY("outlet_id","item_id","date")
);
--> statement-breakpoint
CREATE TABLE "recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"forecast_id" uuid NOT NULL,
	"prep_qty" integer NOT NULL,
	"confidence" double precision,
	"status" "recommendation_status" DEFAULT 'pending' NOT NULL,
	"approved_by" uuid
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"outlet_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"date" date NOT NULL,
	"qty_sold" integer NOT NULL,
	CONSTRAINT "sales_outlet_id_item_id_date_pk" PRIMARY KEY("outlet_id","item_id","date")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outlet_id" uuid NOT NULL,
	"name" text NOT NULL,
	"telegram_user_id" text,
	"role" "user_role" DEFAULT 'staff' NOT NULL,
	CONSTRAINT "users_telegram_user_id_unique" UNIQUE("telegram_user_id")
);
--> statement-breakpoint
CREATE TABLE "waste_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outlet_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"logged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"weight_kg" numeric(8, 3) NOT NULL,
	"portion_count" integer,
	"cause" text NOT NULL,
	"source" "waste_source" NOT NULL,
	"photo_url" text,
	"confidence" double precision,
	"confirmed_by" uuid
);
--> statement-breakpoint
ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_item_id_menu_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."menu_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_requests" ADD CONSTRAINT "pickup_requests_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_requests" ADD CONSTRAINT "pickup_requests_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prep_logs" ADD CONSTRAINT "prep_logs_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prep_logs" ADD CONSTRAINT "prep_logs_item_id_menu_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."menu_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_forecast_id_forecasts_id_fk" FOREIGN KEY ("forecast_id") REFERENCES "public"."forecasts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_item_id_menu_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."menu_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waste_entries" ADD CONSTRAINT "waste_entries_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waste_entries" ADD CONSTRAINT "waste_entries_item_id_menu_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."menu_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waste_entries" ADD CONSTRAINT "waste_entries_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "forecasts_outlet_date_idx" ON "forecasts" USING btree ("outlet_id","date");--> statement-breakpoint
CREATE INDEX "menu_items_outlet_idx" ON "menu_items" USING btree ("outlet_id");--> statement-breakpoint
CREATE INDEX "waste_entries_outlet_logged_idx" ON "waste_entries" USING btree ("outlet_id","logged_at");