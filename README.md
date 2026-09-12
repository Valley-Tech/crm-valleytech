# CRM ValleyTech

CRM multi-tenant para administrar los chatbots de WhatsApp Business API que desarrollas
para tus clientes: bandeja unificada, traspaso bot ↔ humano, plantillas, medición de
consumo y un contrato estable para conectar tus bots existentes.

---

## Arrancarlo en tu computador (5 pasos)

Necesitas **Node.js 20 o superior** y **Docker** (solo para Postgres y Redis).

```bash
# 1. Dependencias
npm install

# 2. Base de datos y Redis
docker compose up -d

# 3. Configuración
cp .env.example .env
npm run keygen   # ejecútalo dos veces: una para JWT_SECRET, otra para CREDENTIALS_ENCRYPTION_KEY
#   Pega cada clave en su variable dentro de .env y completa META_APP_ID y META_APP_SECRET.

# 4. Tablas + usuario administrador
npm run setup
#   Imprime el correo y la contraseña del primer usuario. Guárdalos.

# 5. Los dos procesos (en dos terminales)
npm run dev          # API + bandeja web  → http://localhost:3000
npm run dev:worker   # procesa las colas
```

Abre <http://localhost:3000> y entra con las credenciales que imprimió el paso 4.

> **El worker no es opcional.** El proceso web solo encola; si el worker no corre, los
> mensajes entrantes no se guardan y los salientes no salen.

### Recibir webhooks en local

Meta necesita una URL pública HTTPS. Expón tu puerto 3000 con ngrok o cloudflared:

```bash
ngrok http 3000
```

Luego, en el panel de Meta → WhatsApp → Configuración:

- **URL de devolución de llamada**: `https://TU-URL-PUBLICA/webhooks/meta`
- **Token de verificación**: el mismo valor de `META_WEBHOOK_VERIFY_TOKEN`
- **Campos suscritos**: `messages` como mínimo. Para coexistencia añade `history`,
  `smb_message_echoes` y `smb_app_state_sync`.

Actualiza también `PUBLIC_URL` en tu `.env`.

### Conectar el primer número

Mientras Meta no apruebe la revisión de la app, el alta es manual:

```bash
curl -X POST http://localhost:3000/api/integrations/meta \
  -H "Authorization: Bearer TU_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "wabaId": "TU_WABA_ID",
    "phoneNumberId": "TU_PHONE_NUMBER_ID",
    "accessToken": "TOKEN_DE_USUARIO_DEL_SISTEMA"
  }'
```

El CRM valida el token contra Meta antes de guardarlo, suscribe tu app a esa WABA y
almacena el token cifrado con AES-256-GCM. Cuando Meta apruebe la revisión, el mismo
flujo existe automatizado en `POST /api/integrations/meta/embedded-signup`.

---

## Qué cambió respecto al esqueleto anterior

| Problema | Cómo se resolvió |
|---|---|
| `P1012: DATABASE_URL not found` tumbaba el arranque | `src/config/env.js` valida todo con zod y lista de golpe lo que falta |
| `prisma migrate deploy` en el `start` sin migraciones | `start` solo arranca; las migraciones van en `npm run release` (pre-deploy) |
| Redis sin manejador de `error` tumbaba el proceso | `src/lib/redis.js` registra `error` en cada cliente |
| Solo se leía `entry[0].changes[0]` | El webhook recorre **todas** las entry y changes |
| Reintentos de Meta duplicaban mensajes | `wa_message_id` es único; el duplicado se descarta |
| Los estados retrocedían (`read` → `delivered`) | `status_rank`: el estado solo avanza |
| El worker corría dentro del proceso web | `src/worker.js` es un proceso aparte |
| Los mensajes del bot no se guardaban | Todo saliente se persiste **antes** de enviarse |
| Se ignoraba la ventana de 24 h | Se bloquea el texto libre fuera de ventana y se exige plantilla |
| Los medios se perdían al caducar la URL | Cola de descarga que los guarda en disco o S3 |
| `messages` sin `tenant_id` | Está en todas las tablas, y toda consulta parte del token |
| Motor de flujos que contradecía tus bots | Eliminado; en su lugar, el Bot Gateway |
| Sin API, sin login, sin interfaz | JWT + roles + API REST + WebSocket + bandeja web |

---

## Cómo se conectan tus bots

**El hecho que manda:** una app de Meta tiene **un solo webhook**. Con Embedded Signup
todos tus clientes cuelgan de la app *Chatbot ValleyTech*, así que el CRM tiene que ser
el único receptor y repartir. Tus bots dejan de recibir webhooks de Meta.

```
Meta ──(1 webhook)──> CRM ──(evento firmado)──> tu bot
                       ↑                          │
                       └────(POST /api/v1/bot/messages)
```

### 1. Registra el bot en el CRM

```bash
curl -X POST http://localhost:3000/api/bots \
  -H "Authorization: Bearer TU_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"ValleyTechBot","endpointUrl":"https://valleytechbot.up.railway.app/crm/events"}'
```

Devuelve **una sola vez** `apiKey` y `signingSecret`. Guárdalos como variables de
entorno en el bot: `CRM_API_KEY` y `CRM_SIGNING_SECRET`.

### 2. El bot recibe el evento

`POST {endpointUrl}` con cabeceras:

| Cabecera | Contenido |
|---|---|
| `X-ValleyTech-Event` | `message.received` |
| `X-ValleyTech-Timestamp` | milisegundos |
| `X-ValleyTech-Signature` | `sha256=` + HMAC-SHA256 de `timestamp + "." + cuerpo` con tu `signingSecret` |

Cuerpo:

```json
{
  "event": "message.received",
  "tenant":       { "id": "...", "name": "ValleyTech" },
  "conversation": { "id": "...", "botActive": true, "botState": {}, "windowExpiresAt": "..." },
  "contact":      { "id": "...", "waId": "573001112233", "name": "Ana" },
  "message":      { "id": "...", "type": "text", "text": "hola", "content": { } },
  "integration":  { "phoneNumberId": "...", "displayPhoneNumber": "+57 300 111 2233" }
}
```

### 3. El bot responde

```bash
POST /api/v1/bot/messages
X-Bot-Key: vtk_...

{ "conversationId": "...", "type": "text", "text": "¡Hola! ¿En qué te ayudo?",
  "botState": { "paso": "menu_principal" } }
```

El CRM decide si ese envío sale. Si un agente tomó la conversación responde **409
`bot_paused`** y no envía nada: así el bot nunca pisa a un humano.

Otros endpoints para el bot:

- `POST /api/v1/bot/conversations/:id/handoff` — escalar a un humano
- `PATCH /api/v1/bot/conversations/:id/state` — guardar el estado conversacional
- `GET /api/v1/bot/conversations/:id` — leer estado y ventana de 24 h

En `examples/bot-adapter.js` tienes el adaptador listo para pegar en tus bots.

> **Importante para tus bots actuales:** hoy guardan el estado en memoria
> (`assistantState`, `userOrderDataMap`), y eso se borra en cada despliegue. Muévelo a
> `botState`: el CRM te lo devuelve en cada evento y lo persiste en Postgres.

---

## Mapa del proyecto

```
src/
├── server.js              proceso web (API + WebSocket + bandeja)
├── worker.js              proceso worker (colas)
├── config/env.js          validación de entorno con zod
├── lib/                   prisma, redis, logger, cifrado, contraseñas, firmas
├── whatsapp/              cliente de Graph API, envío, medios, plantillas, signup
├── webhooks/meta.routes.js  ÚNICO punto de entrada de Meta
├── queues/
│   ├── index.js           definición de las 4 colas
│   └── processors/        inbound, outbound, medios, despacho a bots
├── services/              conversaciones, mensajería, bot gateway, consumo, auditoría
├── realtime/              socket.io + puente Redis worker → web
├── http/                  app, middleware y rutas REST
└── storage/               disco local o S3/R2
```

### Las cuatro colas

| Cola | Qué hace |
|---|---|
| `crm.inbound` | Procesa cada `change` del webhook: contactos, mensajes, estados, coexistencia |
| `crm.outbound` | Llama a Meta para enviar; limitada a `OUTBOUND_RATE_PER_SECOND` |
| `crm.media` | Descarga el archivo antes de que caduque la URL de Meta |
| `crm.bot-dispatch` | Entrega el evento firmado a cada bot, con reintentos |

Los trabajos fallidos **se conservan** en Redis: son tu cola de fallidos.

---

## API REST (resumen)

Todo bajo `/api` exige `Authorization: Bearer <token>` salvo el login.

| Método | Ruta | Rol |
|---|---|---|
| POST | `/api/auth/login` | público |
| GET | `/api/auth/me` | cualquiera |
| GET | `/api/conversations` | cualquiera |
| GET | `/api/conversations/:id/messages` | cualquiera |
| POST | `/api/conversations/:id/messages` | agente |
| PATCH | `/api/conversations/:id` | agente |
| POST | `/api/conversations/:id/bot/pause` · `/resume` | agente |
| GET/POST | `/api/conversations/:id/notes` | agente |
| GET | `/api/media/:messageId` | cualquiera (acepta `?token=`) |
| GET/PATCH | `/api/contacts` | agente |
| GET/POST | `/api/integrations` · `/api/integrations/meta` | admin |
| GET/POST | `/api/templates` · `/api/templates/sync` | admin |
| GET/POST/PATCH/DELETE | `/api/bots` | admin |
| GET/POST | `/api/users` | admin |
| GET | `/api/usage/summary` | admin |

Roles, de menor a mayor: `viewer` → `agent` → `admin` → `owner`.

---

## Guardar multimedia en S3 o R2

Por defecto los archivos van a `./storage` para que funcione sin credenciales.
Para usar S3 o Cloudflare R2, instala el SDK y cambia el controlador:

```bash
npm install @aws-sdk/client-s3
```

```env
STORAGE_DRIVER=s3
S3_BUCKET=...  S3_REGION=...  S3_ACCESS_KEY_ID=...  S3_SECRET_ACCESS_KEY=...
```

En Railway es obligatorio: el disco de un contenedor se borra en cada despliegue.

---

## Desplegar en Railway

1. **Dos servicios desde este mismo repositorio**:
   - *web* → `npm run start`, healthcheck en `/health`
   - *worker* → `npm run start:worker`, sin healthcheck
2. En **ambos**, enlaza las variables a los servicios gestionados:
   `DATABASE_URL = ${{Postgres.DATABASE_URL}}` y `REDIS_URL = ${{Redis.REDIS_URL}}`.
   *Esto es exactamente lo que faltaba y causaba el `P1012`.*
3. Copia el resto de variables de `.env.example`. Las claves de producción deben ser
   distintas a las de tu máquina.
4. En el servicio *web*, pon `npm run release` como **pre-deploy command** para aplicar
   las migraciones. Nunca en el `start`: si falla, el contenedor entra en bucle.
5. `PUBLIC_URL` con el dominio del servicio web, y esa misma URL + `/webhooks/meta` en
   el panel de Meta.

---

## Lo que todavía falta (por orden)

1. **Revisión de la app en Meta** — sin ella no hay Embedded Signup en producción. Es el
   camino crítico más largo: empiézalo ya.
2. Migrar los tres bots al Bot Gateway (`examples/bot-adapter.js` es el punto de partida).
3. Row Level Security en Postgres como segunda barrera entre clientes.
4. Panel de administración en la interfaz: hoy integraciones, bots y plantillas se
   gestionan por API.
5. Informes: tiempo de primera respuesta, conversaciones por agente, conversión del embudo.
6. Planes, límites y suspensión por impago sobre la tabla `usage_events`.
