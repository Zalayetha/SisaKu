DO $$
DECLARE n bigint; sample text;
BEGIN
	SELECT count(*) INTO n FROM "menu_items" WHERE "portion_weight_kg" <= 0;
	IF n > 0 THEN
		SELECT string_agg(name || ' (' || id || ')', ', ') INTO sample
			FROM (SELECT "name", "id" FROM "menu_items" WHERE "portion_weight_kg" <= 0 ORDER BY "name" LIMIT 5) x;
		RAISE EXCEPTION '% menu_items have portion_weight_kg <= 0; set a real portion weight first: %', n, sample;
	END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_portion_weight_kg_positive" CHECK ("menu_items"."portion_weight_kg" > 0);
