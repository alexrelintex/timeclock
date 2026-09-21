-- Employees carry the given and family name the HRIS supplies, beside the
-- display name. Nullable: a record created with only a display name stays so.
ALTER TABLE "Agent" ADD COLUMN "firstName" TEXT,
                    ADD COLUMN "lastName" TEXT;
