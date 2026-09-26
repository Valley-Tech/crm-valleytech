-- IA (Gemini) por chatbot + base de conocimiento (archivos, sitios web, FAQ).
ALTER TABLE "bot_integrations"
  ADD COLUMN "ai_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "ai_model" TEXT,
  ADD COLUMN "ai_instructions" TEXT,
  ADD COLUMN "ai_temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.4,
  ADD COLUMN "ai_max_chars" INTEGER NOT NULL DEFAULT 600,
  ADD COLUMN "file_search_store" TEXT;

CREATE TABLE "knowledge_sources" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "bot_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "error" TEXT,
  "mime_type" TEXT,
  "size_bytes" INTEGER,
  "storage_key" TEXT,
  "source_url" TEXT,
  "content" TEXT,
  "document_name" TEXT,
  "documents" JSONB,
  "pages" INTEGER NOT NULL DEFAULT 0,
  "indexed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "knowledge_sources_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "knowledge_sources_bot_id_kind_idx" ON "knowledge_sources"("bot_id", "kind");
CREATE INDEX "knowledge_sources_tenant_id_idx" ON "knowledge_sources"("tenant_id");

ALTER TABLE "knowledge_sources"
  ADD CONSTRAINT "knowledge_sources_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_sources"
  ADD CONSTRAINT "knowledge_sources_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bot_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
