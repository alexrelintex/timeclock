-- Manager ID requirement removed from the HRIS integration. The column is all-null
-- (positionData.manager was never populated), so dropping it loses no data.
ALTER TABLE "Agent" DROP COLUMN IF EXISTS "hrisManagerId";
