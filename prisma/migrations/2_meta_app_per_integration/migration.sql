-- Cada número puede pertenecer a una app de Meta distinta de la del CRM.
ALTER TABLE "meta_integrations"
  ADD COLUMN "meta_app_id" TEXT,
  ADD COLUMN "meta_app_secret_enc" TEXT,
  ADD COLUMN "last_webhook_at" TIMESTAMP(3),
  ADD COLUMN "last_inbound_at" TIMESTAMP(3);
