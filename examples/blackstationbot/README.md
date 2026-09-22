# Conectar BlackStationBot al CRM (Bot Gateway)

Estos 4 archivos se generaron a partir del código **original** de `BlackStationBot` (no del de
ValleyTechBot): conservan el mapa de productos del catálogo, `idNumber`, `handleHiringFlow`,
los Flows (`flow.js`, `flowEncuesta.js`…) y la exportación `downloadImageFromMeta` que usa
`messageHandler.js`. Solo se añade el puente con el CRM.

Copia cada archivo en la misma ruta dentro del repo `BlackStationBot`:

| Archivo | Acción | Qué cambia |
|---|---|---|
| `src/services/crmAdapter.js` | **nuevo** | Puente con el CRM (reenviar webhooks, registrar envíos, pausa del bot, eventos en modo gateway). |
| `src/services/httpRequest/sendToWhatsApp.js` | reemplaza | Misma firma y **mismas exportaciones** (`default` + `downloadImageFromMeta`). En modo espejo envía a Meta y registra en el CRM; en gateway envía por el CRM. Sigue relanzando el error (`throw`) como el original. |
| `src/controllers/webhookController.js` | reemplaza | `handleIncoming` reenvía el webhook al CRM y responde 200 antes de procesar; se añade `handleCrmEvent`; la lógica original (productos, pedidos, Flows, Wompi) está intacta dentro de `dispatch`. |
| `src/routes/webhookRoutes.js` | reemplaza | Añade `POST /crm/events` y conserva `/flow`, `/webhook`, `/wompi`. |

No se toca `messageHandler.js`, `whatsappService.js`, `flow*.js`, `geminiService.js` ni `wompiService.js`.

## Variables en Railway (servicio BlackStationBot)

```
CRM_BASE_URL=https://<tu-crm>.up.railway.app
CRM_API_KEY=<apiKey del chatbot "Black Station" creado en CRM → Chatbots>
CRM_SIGNING_SECRET=<signingSecret del mismo chatbot>
CRM_MODE=mirror
CRM_PHONE_NUMBER_ID=<phone_number_id del número>   # opcional: si falta usa BUSINESS_PHONE. Así el CRM sabe de qué número/chatbot es cada chat
```

En el CRM → Chatbots, registra el bot con la URL `https://<tu-bot>.up.railway.app/crm/events`
y en **Atiende** elige el número de Black Station. Las credenciales son distintas para cada bot.

## Modos

- `mirror` (empieza aquí): no cambia nada en Meta. Contactos, entrantes, respuestas del bot y
  estados aparecen en la bandeja; "Pausar bot" funciona.
- `gateway`: el CRM es el único webhook de la app de Meta de este número. Cambia la URL del
  webhook en Meta a `https://<tu-crm>.up.railway.app/webhooks/meta` (token de verificación =
  `META_WEBHOOK_VERIFY_TOKEN` del CRM) y pon `CRM_MODE=gateway`.

## Importante para BlackStationBot

En el commit "agregando chatbot a Bot Gateway" se subieron a este repo los archivos de
ValleyTechBot (por eso los errores `flowSorteo.js` y `downloadImageFromMeta`). Estos 4 archivos
**reemplazan** a esos: parten del `webhookController.js` original de 846 líneas (commit
`ad75c08`, "agregando numeros oficiales"), con `getNextScreen` de `flow.js` y `nextEncuesta`
de `flowEncuesta.js` restaurados.
