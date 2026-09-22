# Conectar ValleyTechBot (Gemini) al CRM

Copia estos 4 archivos sobre tu repo ValleyTechBot (misma ruta cada uno):

| Archivo | Qué cambia |
|---|---|
| `src/services/crmAdapter.js` | **nuevo** — el puente con el CRM |
| `src/services/httpRequest/sendToWhatsApp.js` | reemplazo — misma firma; registra en el CRM o envía por él |
| `src/controllers/webhookController.js` | `handleIncoming` reenvía el webhook al CRM y se añade `handleCrmEvent`; el resto (flows, Wompi) está intacto |
| `src/routes/webhookRoutes.js` | añade `/crm/events` |

No hay que tocar `messageHandler.js`, `GeminiService.js`, `whatsappService.js` ni nada más.

## Variables nuevas en Railway (servicio del bot)

```
CRM_BASE_URL=https://<tu-crm>.up.railway.app
CRM_API_KEY=<apiKey que muestra el CRM al crear el chatbot en "Chatbots">
CRM_SIGNING_SECRET=<signingSecret del mismo chatbot>
CRM_MODE=mirror
CRM_PHONE_NUMBER_ID=<phone_number_id del número>   # opcional: si falta usa BUSINESS_PHONE. Así el CRM sabe de qué número/chatbot es cada chat
```

## Modo `mirror` (empieza por aquí — no cambia nada en Meta)

El bot sigue igual que hoy, pero todo lo que recibe y envía queda reflejado en el CRM:
contactos, chats, mensajes entrantes, respuestas de Gemini (como "bot"), estados de entrega.
Además, si un agente pulsa "Pausar bot" en la bandeja, el bot deja de responder a ese número.

## Modo `gateway` (cuando quieras que el CRM sea el único webhook)

1. En el CRM → Chatbots, pon como URL del bot `https://<tu-bot>.up.railway.app/crm/events`.
2. En Meta for Developers → tu app → WhatsApp → Configuración → Webhook, cambia la URL de
   callback a `https://<tu-crm>.up.railway.app/webhooks/meta` con el `META_WEBHOOK_VERIFY_TOKEN` del CRM.
3. Cambia `CRM_MODE=gateway` en el bot. `API_TOKEN`, `BUSINESS_PHONE` y `APP_SECRET` ya no se usan
   para mensajes (los Flows cifrados siguen usando `PRIVATE_KEY`/`APP_SECRET`).
