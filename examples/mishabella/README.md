# Mishabella — compra en línea con Flow + conexión al CRM (Bot Gateway)

Estos archivos se generaron leyendo el código real de `Valley-Tech/mishabella`.
Hacen dos cosas a la vez:

1. **Compra en línea**: el cliente elige del catálogo → se abre un **Flow de
   WhatsApp** con los datos de envío (como en Samuelito) → según el medio de
   pago (*Efectivo o contra-entrega*, *Transferencia*, *PSE*) el bot responde y
   guarda el pedido en la hoja de cálculo.
2. **Bot Gateway**: el bot queda conectado al CRM igual que ValleyTechBot,
   Samuelito y BlackStation.

## Archivos

Copia cada uno en la **misma ruta** dentro del repo `mishabella`:

| Archivo | Acción | Qué hace |
|---|---|---|
| `src/services/sessionStore.js` | **nuevo** | Guarda el pedido de cada cliente por separado, identificado con el `flow_token`. Resiste reinicios (se respalda en `./data/sessions.json`). |
| `src/services/flowPedido.js` | **nuevo** | Punto de conexión del Flow del pedido: pantalla `DETAILS` → `SUMMARY` → `SUCCESS`. |
| `src/services/catalogoProductos.js` | **nuevo** | Consulta el catálogo de Meta (Shopify) para poner nombre y variante (diseño, talla, color) a cada id del pedido, con caché. |
| `src/services/crmAdapter.js` | **nuevo** | Puente con el CRM (reenviar webhooks, registrar envíos, pausa del bot, eventos en modo gateway). |
| `src/services/messageHandler.js` | reemplaza | Flujo de compra rediseñado + todo lo que ya tenías (saludo, Gemini, sorteo, Wompi, contacto, ubicación). |
| `src/controllers/webhookController.js` | reemplaza | Reenvía al CRM, responde 200 antes de procesar, `handleCrmEvent`, y reparte los Flows entre pedido y sorteo. |
| `src/routes/webhookRoutes.js` | reemplaza | Añade `POST /crm/events`; conserva `/webhook`, `/flow` y `/wompi`. |
| `src/services/whatsappService.js` | reemplaza | Añade `sendFlow()` y `sendTemplateVariables()`. `sendUrl()` sigue funcionando igual. |
| `src/services/httpRequest/sendToWhatsApp.js` | reemplaza | Misma firma; en modo espejo registra en el CRM, en modo gateway envía por el CRM. |
| `src/services/googleSheetsService.js` | reemplaza | Igual que el tuyo **más** `actualizarEstadoPedido()` (marca "Confirmado" cuando Wompi aprueba). |
| `src/config/env.js` | reemplaza | Añade las variables nuevas (Flow IDs, domicilio, cuentas bancarias, avisos). |

No se tocan: `app.js`, `encryption.js`, `flowSorteo.js`, `GeminiService.js`,
`wompiService.js` ni `package.json` (no hay dependencias nuevas).

Agrega `data/` a tu `.gitignore`: ahí se respaldan los pedidos en curso.

## Variables en Railway

```
# --- Flows -----------------------------------------------------------
FLOW_ID_PEDIDO=1490489532006105      # el Flow que se abre al comprar
FLOW_ID_SORTEO=<id del flow del sorteo>   # ojo: ver la nota de abajo

# --- Catálogo --------------------------------------------------------
SHOPIFY_STORE_URL=https://mishabellastore.com   # nombres y variantes sin permisos de Meta
CATALOG_LOOKUP_META=false            # true cuando la app tenga Marketing API + catalog_management

# --- Pedido ----------------------------------------------------------
COSTO_DOMICILIO=0                    # 0 = no se cobra domicilio
SPREADSHEET_PEDIDOS=1tuenjbpcJFLjiWIhcTIqdIdGA5cvLA5xyDDVKG2hG08
CUENTAS_BANCARIAS=- *Bancolombia Ahorros:* 52300000966
NOTIFY_NUMBERS=573161763710          # opcional: avisos de pedido nuevo
NOTIFY_TEMPLATE=pedido_nuevo         # plantilla aprobada para el aviso (ver abajo)
NOTIFY_TEMPLATE_LANG=es_CO           # idioma con el que se creó la plantilla

# --- CRM (Bot Gateway) -----------------------------------------------
CRM_BASE_URL=https://crm-valleytech-production.up.railway.app
CRM_API_KEY=<apiKey del chatbot "Mishabella" creado en CRM → Chatbots>
CRM_SIGNING_SECRET=<signingSecret del mismo chatbot>
CRM_MODE=mirror
CRM_PHONE_NUMBER_ID=<phone_number_id del número de Mishabella>   # si falta, usa BUSINESS_PHONE
```

`CRM_PHONE_NUMBER_ID` (o `BUSINESS_PHONE`, que ya tienes) le dice al CRM por
qué número sale cada mensaje. Sin eso, los chats que abre el bot (por ejemplo
los avisos de pedido) quedaban **sin número asignado** en la bandeja y no se
podían responder.

> **Importante sobre los dos Flow IDs.** En tu código actual, el Flow del
> sorteo (`menuUrl`, opción "Tienda Virtual") usa `1490489532006105`, que es el
> mismo ID que me diste para el pedido. Un Flow no puede ser las dos cosas.
> Si ese Flow ahora es el del **pedido**, pon en `FLOW_ID_SORTEO` el ID del
> Flow del sorteo (o quita la opción 2 del menú). Si el del pedido es otro,
> corrige `FLOW_ID_PEDIDO`. Mientras no lo definas, las dos variables apuntan
> al mismo Flow y la opción 2 abrirá el formulario equivocado.

## Cómo queda el flujo de compra

```
Cliente: "Hola"                → menú (Comprar 🛒 / Tienda Virtual 🛍️)
Cliente: Comprar               → plantilla catalogos_productos
Cliente: envía el pedido       → resumen con nombres y total
                               → se abre el Flow "Pedido" (flow_id + flow_token)
Cliente: llena el Flow         → pantalla DETAILS  → resumen de confirmación
Cliente: confirma              → pantalla SUMMARY  → SUCCESS (se cierra el Flow)
Bot:                           → según el medio de pago:
   Efectivo o contra-entrega   → "¡Pedido recibido! Pagas al recibir"
   Transferencia               → cuentas bancarias + "envíanos el comprobante"
   PSE                         → link de Wompi; al aprobarse, confirma solo
                               → en los tres casos guarda la fila en la hoja
```

### El Flow en Meta

El Flow del pedido debe tener dos pantallas con estos nombres:

| Pantalla | Qué hace | Campos que espera el código |
|---|---|---|
| `DETAILS` | Datos de envío. Al continuar hace `data_exchange`. | `name`, `phone`, `address` (opcional), `pago`, `recomendacion` (opcional) |
| `SUMMARY` | Muestra `details` y confirma. | — |

Si en tu Flow los campos están en español (`nombre`, `celular`, `direccion`,
`medio_pago`, `recomendaciones`) también funciona: el código acepta las dos
formas. El medio de pago se interpreta por palabra clave, así que sirve
"Efectivo", "Contraentrega", "Efectivo o contra-entrega", "Transferencia",
"En linea PSE"…

La **URI del endpoint** del Flow en Meta debe ser `https://<tu-bot>/flow`,
la misma que ya usas para el sorteo: el código reparte según el `flow_token`.

### Catálogo Shopify: variantes

El catálogo de Meta se sincroniza desde Shopify, así que cada variante es un
producto distinto: el `product_retailer_id` del pedido (ej. `55711086412081`)
es el id de la **variante**, y el producto padre es el grupo
(`retailer_product_group_id`, ej. `10760524202289`). Con cientos de variantes
no se puede mantener un diccionario a mano, así que `catalogoProductos.js`
consulta la Graph API del catálogo en **una sola llamada por pedido**:

```
GET /v23.0/{catalog_id}/products
    ?fields=retailer_id,retailer_product_group_id,name,color,size,additional_variant_attributes,...
    &filter={"retailer_id":{"is_any":["55711086412081","55711088967985"]}}
```

y el resumen queda así:

```
• 1 × NUEVO CONJUNTO MULTIUSOS MATCH DE AMOR (Diseño: Candado · Talla: M) — $189.900
• 2 × NUEVO CONJUNTO MULTIUSOS MATCH DE AMOR (Diseño: LOVE · Talla: L) — $379.800
```

Las respuestas se guardan en caché (memoria + `data/catalogo-cache.json`, 7 días),
así que cada variante se consulta una sola vez. Si la API falla, el pedido
sigue con `Producto <id>` y el log dice por qué.

**De dónde salen los nombres (en este orden):**

1. `PRODUCT_NAMES` (manual, opcional).
2. **Tu tienda Shopify**: `SHOPIFY_STORE_URL/products.json` es público, no
   necesita token ni permisos de Meta, y usa los mismos ids de variante que
   llegan en el pedido. El bot descarga el índice completo (250 productos por
   página), lo guarda 6 horas y lo refresca si llega un id que no conoce. Es la
   fuente que funciona hoy.
3. La Graph API del catálogo de Meta, solo para ids que Shopify no tenga. Para
   que esta ruta funcione la **app** (no el token) necesita el producto
   **Marketing API**: Meta for Developers → tu app → *Panel* → *Agregar
   producto* → **Marketing API** → *Configurar*. Solo después de eso aparece
   `catalog_management` en la lista de permisos al generar el token del usuario
   del sistema (Business Manager → Usuarios del sistema → Generar token), y hay
   que asignarle el catálogo (*Asignar activos* → *Catálogos*). Mientras no
   esté, el log dirá `(#100) This application has not been approved to use
   this api` y el bot seguirá usando Shopify. Puedes apagar este intento con
   `CATALOG_LOOKUP_META=false`.

`PRODUCT_NAMES` sigue existiendo como anulación manual (gana sobre la API).

### Aviso de pedido nuevo (por qué salía "falló · Re-engagement message")

El aviso a `NOTIFY_NUMBERS` es un mensaje que el **negocio** recibe del bot.
Para WhatsApp es un mensaje iniciado por la empresa: solo se entrega como
texto libre si ese número le escribió al bot en las últimas 24 h. Si no, Meta
lo rechaza con el error **131047 "Re-engagement message"** y en el CRM aparece
como *falló*. No es un fallo del bot ni del CRM: es la regla de la ventana de
24 h.

La solución definitiva es una **plantilla de utilidad**. En WhatsApp Manager →
Plantillas → Crear:

| Campo | Valor |
|---|---|
| Nombre | `pedido_nuevo` |
| Categoría | **Utilidad** |
| Idioma | Español (COL) → código `es_CO` (si eliges otro, pon ese código en `NOTIFY_TEMPLATE_LANG`) |
| Cuerpo | ver abajo (6 variables, en este orden) |

```
🛒 Pedido nuevo en Mishabella
Cliente: {{1}}
Celular: {{2}}
Dirección: {{3}}
Pedido: {{4}}
Pago: {{5}}
Total: {{6}}
```

Ejemplos para la revisión: `María Pérez`, `3001234567`, `Calle 10 # 5-20, Cali`,
`1 x Body Premium IS (Diseño: Ébano · Color: Amarillo) — $80.000`, `Efectivo`,
`$80.000`.

Cuando esté aprobada (suele tardar minutos), pon `NOTIFY_TEMPLATE=pedido_nuevo`
en Railway. El código ya manda las 6 variables (`notificarPedido`), quitando
saltos de línea, que Meta no acepta dentro de una variable. Las plantillas de
utilidad se cobran por conversación; alternativa gratis: que cada número de
`NOTIFY_NUMBERS` le escriba "hola" al bot una vez al día para mantener la
ventana abierta (poco práctico).

### Columnas de la hoja de pedidos

`A` WhatsApp · `B` Nombre · `C` Pedido · `D` Celular · `E` Dirección ·
`F` Medio de pago · `G` Fecha · `H` Total · `I` Estado · `J` Recomendaciones

Las columnas A–G son las mismas que ya usabas; H, I y J son nuevas.

## Qué más se corrigió

- **Dos clientes a la vez.** Antes el pedido vivía en variables globales del
  controlador (`datosPedido`, `pedidoStr`): si dos personas compraban al mismo
  tiempo, la segunda pisaba a la primera. Ahora cada pedido va con su
  `flow_token`.
- **Meta ya no reintenta.** El webhook responde 200 antes de llamar a Gemini o
  a Sheets; antes, si la respuesta tardaba, Meta reenviaba el mismo mensaje.
- **Gemini con memoria por cliente.** `geminiAiService(message)` se llamaba sin
  el id del usuario, así que todos compartían el mismo historial. Ahora se pasa
  el número.
- **Wompi para pedidos.** El evento de pago solo sabía actualizar boletas del
  sorteo; ahora también marca el estado del pedido en la hoja.
- **Nombres de producto.** El resumen mostraba el SKU del catálogo; con
  `catalogoProductos.js` muestra el nombre (y avisa en los logs de los SKU que
  faltan por registrar).

## Clave privada de los Flows (endpoint cifrado)

`config/env.js` normaliza `PRIVATE_KEY`: acepta el PEM con saltos de línea
reales **o** en una sola línea con `\n` escapados (como la clave de Google), y
al arrancar avisa si la clave o la passphrase no sirven:

```
[flows] clave privada cargada correctamente ✅
[flows] ❌ no se pudo leer la clave privada: ERR_OSSL_UNSUPPORTED
```

Antes de pelear con la comprobación de estado de Meta, prueba la clave sola:

```bash
node scripts/probar-clave.mjs private.pem "TuPassphrase"
```

Imprime si la clave es válida, la clave pública que le corresponde (para
compararla con la que subiste a Meta) y la línea lista para pegar en el `.env`.

## Registrar el bot en el CRM

En el CRM → **Chatbots** → *Registrar chatbot*: nombre `Mishabella`, endpoint
`https://<tu-bot>.up.railway.app/crm/events`, y en **Atiende** el número de
Mishabella. Copia `CRM_API_KEY` y `CRM_SIGNING_SECRET` a Railway.

Empieza con `CRM_MODE=mirror` (no cambia nada en Meta). Cuando lo verifiques,
cambia el webhook de la app de Meta a `https://<tu-crm>/webhooks/meta` y pon
`CRM_MODE=gateway`. El endpoint `/flow` sigue recibiendo directo de Meta en
los dos modos: los Flows no pasan por el webhook de mensajes.
