-- v2.12: proveedor de IA por chatbot (gemini | claude) y texto extraído de cada fuente.
ALTER TABLE "bot_integrations" ADD COLUMN "ai_provider" TEXT NOT NULL DEFAULT 'gemini';
ALTER TABLE "knowledge_sources" ADD COLUMN "extracted_text" TEXT;
