-- v2.8: dueños de chatbot. Cada usuario ve solo los números (chatbots) que
-- tiene asignados; el superadmin lo ve todo.

-- 1) Asignación usuario ↔ número de WhatsApp.
CREATE TABLE "user_integrations" (
  "user_id" TEXT NOT NULL,
  "integration_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_integrations_pkey" PRIMARY KEY ("user_id", "integration_id")
);
CREATE INDEX "user_integrations_integration_id_idx" ON "user_integrations"("integration_id");
ALTER TABLE "user_integrations"
  ADD CONSTRAINT "user_integrations_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_integrations"
  ADD CONSTRAINT "user_integrations_integration_id_fkey"
  FOREIGN KEY ("integration_id") REFERENCES "meta_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2) El primer "owner" de cada cliente (el creado por el seed, p. ej.
--    admin@valleytech.local) pasa a ser superadmin. Los demás owner quedan
--    como "Dueño" de chatbot y hay que asignarles sus números en Usuarios.
UPDATE "users" SET "role" = 'superadmin'
WHERE "id" IN (
  SELECT DISTINCT ON ("tenant_id") "id" FROM "users"
  WHERE "role" = 'owner' AND "active" = true
  ORDER BY "tenant_id", "created_at" ASC
);
UPDATE "users" SET "role" = 'superadmin' WHERE "email" = 'admin@valleytech.local';
-- Si un cliente quedó sin superadmin (no tenía owner), se promueve su primer admin.
UPDATE "users" SET "role" = 'superadmin'
WHERE "id" IN (
  SELECT DISTINCT ON (u."tenant_id") u."id" FROM "users" u
  WHERE u."role" = 'admin' AND u."active" = true
    AND NOT EXISTS (SELECT 1 FROM "users" s WHERE s."tenant_id" = u."tenant_id" AND s."role" = 'superadmin')
  ORDER BY u."tenant_id", u."created_at" ASC
);

-- 3) Las plantillas son de cada WABA: dos números con WABA distinta pueden
--    tener una plantilla con el mismo nombre e idioma.
DROP INDEX IF EXISTS "templates_tenant_id_name_language_key";
CREATE UNIQUE INDEX "templates_tenant_id_waba_id_name_language_key"
  ON "templates"("tenant_id", "waba_id", "name", "language");

-- 4) Poder eliminar usuarios: sus notas internas se conservan sin autor.
ALTER TABLE "conversation_notes" ALTER COLUMN "user_id" DROP NOT NULL;
ALTER TABLE "conversation_notes" DROP CONSTRAINT IF EXISTS "conversation_notes_user_id_fkey";
ALTER TABLE "conversation_notes"
  ADD CONSTRAINT "conversation_notes_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
