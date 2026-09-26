-- Nuevo rol "superadmin" (dueño del CRM). Va en su propia migración porque en
-- PostgreSQL un valor nuevo de un enum no puede usarse en la misma transacción
-- en la que se crea.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'superadmin';
