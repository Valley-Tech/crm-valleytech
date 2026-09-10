# CRM WhatsApp — ValleyTech

CRM multi-tenant que se conecta directamente a la API de WhatsApp Cloud (Meta), con soporte
para coexistencia con la app WhatsApp Business.

## Estructura

```
prisma/schema.prisma        Modelo de datos multi-tenant (tenants, contactos, conversaciones, bot...)
src/config/env.js            Config centralizada desde variables de entorno
src/db/prisma.js             Cliente Prisma singleton
src/utils/crypto.js          Cifrado AES-256-GCM de tokens de acceso por tenant
src/services/whatsapp/       Envío de mensajes a la API de WhatsApp (texto, plantilla, botones, media)
src/webhooks/                Verificación de firma, handshake y controlador del webhook
src/middleware/tenantResolver.js   Resuelve qué tenant corresponde a cada webhook entrante
src/queue/                   Cola BullMQ + worker que procesa los eventos fuera del request/response
src/bot/botEngine.js         Motor de árbol de decisión (reglas fijas) por tenant
src/routes/                  Rutas Express (webhook, health)
src/server.js                Punto de entrada
```

## Arrancar en local

```bash
cp .env.example .env
# completa META_APP_ID, META_APP_SECRET, WEBHOOK_VERIFY_TOKEN y
# CREDENTIALS_ENCRYPTION_KEY (genera esta última con el comando que
# aparece comentado en .env.example)

docker compose up -d          # levanta Postgres y Redis
npm install
npm run prisma:migrate        # crea las tablas
npm run dev
```

Para exponer tu webhook local a Meta durante desarrollo, usa una herramienta de túnel
(ngrok o similar) y registra esa URL pública + `/webhook` en App Dashboard > WhatsApp > Configuración.

## Lo que falta por construir (siguientes pasos sugeridos)

1. **Flujo de Embedded Signup** (botón de conexión + callback que guarda `MetaIntegration`
   cifrada por tenant). Bloqueado hasta que Meta apruebe `whatsapp_business_messaging` y
   `whatsapp_business_management` en la revisión de la app.
2. **API REST del CRM** para el frontend: listar conversaciones, contactos, pipeline, asignar
   agentes, gestionar plantillas.
3. **WebSocket** (Socket.IO) para que el panel de agentes se actualice en tiempo real cuando
   llega un mensaje nuevo o el bot hace `handoff`.
4. **Autenticación** de usuarios/agentes (JWT) y aislamiento por tenant en cada query (hoy el
   filtro por `tenantId` está en el código de la app; para una capa extra de seguridad se
   recomienda además Row-Level Security en Postgres).
5. **Editor del árbol de bot**: hoy `BotFlow`/`BotNode` se llenan directo en base de datos;
   falta la interfaz (o al menos endpoints CRUD) para que cada tenant configure su propio flujo.
6. **Separar el worker en su propio proceso** (`node src/queue/worker.js`) en vez de correr
   dentro de `server.js`, para poder escalarlo independientemente del API HTTP.

## Notas importantes

- El límite de 20 mensajes/segundo aplica a números en modo coexistencia — considera agregar
  un limiter por `phoneNumberId` en el `Worker` de BullMQ (`opts.limiter`) antes de producción.
- Los tokens de acceso de cada tenant se guardan cifrados (`accessTokenEnc`). Nunca los
  loguees ni los devuelvas en respuestas de la API.
