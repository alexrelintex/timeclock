-- Add HRIS job title + manager id to Agent (persisted for CRM sync; not shown in UI)
ALTER TABLE "Agent" ADD COLUMN "hrisTitle" TEXT;
ALTER TABLE "Agent" ADD COLUMN "hrisManagerId" TEXT;
