-- Add HRIS FLSA type to Agent (persisted for CRM sync; not shown in UI)
ALTER TABLE "Agent" ADD COLUMN "hrisFlsa" TEXT;
