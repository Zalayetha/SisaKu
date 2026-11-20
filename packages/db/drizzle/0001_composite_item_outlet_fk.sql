DO $$
DECLARE bad text;
BEGIN
	SELECT string_agg(t || ': ' || n, ', ') INTO bad FROM (
		SELECT 'sales' AS t, count(*) AS n FROM "sales" r JOIN "menu_items" m ON m."id" = r."item_id" WHERE m."outlet_id" <> r."outlet_id"
		UNION ALL SELECT 'prep_logs', count(*) FROM "prep_logs" r JOIN "menu_items" m ON m."id" = r."item_id" WHERE m."outlet_id" <> r."outlet_id"
		UNION ALL SELECT 'waste_entries', count(*) FROM "waste_entries" r JOIN "menu_items" m ON m."id" = r."item_id" WHERE m."outlet_id" <> r."outlet_id"
		UNION ALL SELECT 'forecasts', count(*) FROM "forecasts" r JOIN "menu_items" m ON m."id" = r."item_id" WHERE m."outlet_id" <> r."outlet_id"
	) x WHERE n > 0;
	IF bad IS NOT NULL THEN
		RAISE EXCEPTION 'rows pair an item with another outlet (table: count): %', bad;
	END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_id_outlet_id_unique" UNIQUE("id","outlet_id");
--> statement-breakpoint
ALTER TABLE "forecasts" DROP CONSTRAINT "forecasts_outlet_id_outlets_id_fk";
--> statement-breakpoint
ALTER TABLE "forecasts" DROP CONSTRAINT "forecasts_item_id_menu_items_id_fk";
--> statement-breakpoint
ALTER TABLE "prep_logs" DROP CONSTRAINT "prep_logs_outlet_id_outlets_id_fk";
--> statement-breakpoint
ALTER TABLE "prep_logs" DROP CONSTRAINT "prep_logs_item_id_menu_items_id_fk";
--> statement-breakpoint
ALTER TABLE "sales" DROP CONSTRAINT "sales_outlet_id_outlets_id_fk";
--> statement-breakpoint
ALTER TABLE "sales" DROP CONSTRAINT "sales_item_id_menu_items_id_fk";
--> statement-breakpoint
ALTER TABLE "waste_entries" DROP CONSTRAINT "waste_entries_outlet_id_outlets_id_fk";
--> statement-breakpoint
ALTER TABLE "waste_entries" DROP CONSTRAINT "waste_entries_item_id_menu_items_id_fk";
--> statement-breakpoint
ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_item_outlet_fk" FOREIGN KEY ("item_id","outlet_id") REFERENCES "public"."menu_items"("id","outlet_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prep_logs" ADD CONSTRAINT "prep_logs_item_outlet_fk" FOREIGN KEY ("item_id","outlet_id") REFERENCES "public"."menu_items"("id","outlet_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_item_outlet_fk" FOREIGN KEY ("item_id","outlet_id") REFERENCES "public"."menu_items"("id","outlet_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waste_entries" ADD CONSTRAINT "waste_entries_item_outlet_fk" FOREIGN KEY ("item_id","outlet_id") REFERENCES "public"."menu_items"("id","outlet_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
