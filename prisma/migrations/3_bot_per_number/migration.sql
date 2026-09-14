-- Un chatbot puede atender un solo número (o todos, si queda en NULL).
ALTER TABLE "bot_integrations" ADD COLUMN "meta_integration_id" TEXT;
ALTER TABLE "bot_integrations"
  ADD CONSTRAINT "bot_integrations_meta_integration_id_fkey"
  FOREIGN KEY ("meta_integration_id") REFERENCES "meta_integrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
