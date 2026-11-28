ALTER TABLE "recommendations" ALTER COLUMN "status" DROP DEFAULT;
CREATE TYPE "public"."recommendation_status_old" AS ENUM('pending', 'approved', 'rejected');
UPDATE "recommendations" SET "status" = 'pending' WHERE "status" = 'not_required';
ALTER TABLE "recommendations" ALTER COLUMN "status" TYPE "public"."recommendation_status_old" USING "status"::text::"public"."recommendation_status_old";
DROP TYPE "public"."recommendation_status";
ALTER TYPE "public"."recommendation_status_old" RENAME TO "recommendation_status";
ALTER TABLE "recommendations" ALTER COLUMN "status" SET DEFAULT 'pending';
