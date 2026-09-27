-- v2.9: el bot se reactiva solo tras N minutos sin actividad (por número).
ALTER TABLE "meta_integrations" ADD COLUMN "bot_resume_minutes" INTEGER NOT NULL DEFAULT 5;

-- Chats que quedaron con el bot pausado "para siempre" (pausa por eco sin
-- caducidad en versiones anteriores): se les pone caducidad ahora, y el
-- barrido del worker los reactiva en el siguiente minuto.
UPDATE "conversations" SET "bot_paused_until" = CURRENT_TIMESTAMP
WHERE "bot_active" = false AND "bot_paused_until" IS NULL AND "status" <> 'closed';
