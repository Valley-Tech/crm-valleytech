# MerkCentro24: búsqueda de productos con la lista en el CRM

## Cómo funcionaba antes

`geminiService.js` tenía quemado el diccionario `product_names` (id → nombre, ~700
productos) y Gemini se usaba dos veces por búsqueda:

1. `[USUARIO]: quiero una gaseosa postobón` → Gemini devolvía **nombres** de la lista.
2. Al confirmar, `[SISTEMA]: …` → Gemini devolvía los **IDs** de esos nombres y el bot
   enviaba cada producto del catálogo con `sendSingleProduct(to, id)`.

Esa información no se guardó en ningún archivo del CRM: estaba solo en el código. Ya la
extraje a `productos-merkcentro.csv` (696 productos; en el diccionario había 7 nombres
repetidos con IDs distintos, se conservan todos).

## Cómo funciona ahora

1. En el CRM → Chatbots → MerkCentro24Bot → IA y conocimiento → **Catálogo de productos**:
   sube `productos-merkcentro.csv` (o pega el diccionario tal cual). Espera a que quede
   "listo" y activa la IA. Prueba con el cuadro "Probar la búsqueda".
2. El bot llama `POST /api/v1/bot/ai/products/search { to, text }` y recibe en **una**
   llamada los productos que coinciden, con sus IDs reales:
   `{ items: [{ id, name, price, category }], none, text }`.
   El CRM primero preselecciona por palabras (sin tildes, plurales) y la IA elige entre
   esos candidatos; solo acepta IDs que existan en la lista (nunca inventa).
3. El bot muestra la lista de WhatsApp (hasta 10 por mensaje); al tocar un producto o
   "Sí, gracias" envía el producto del catálogo con `sendSingleProduct`.
4. La lista también queda como conocimiento: si el cliente pregunta "¿tienen Advil?",
   `/ai/reply` (preguntas libres) la conoce.

Para cambiar precios o agregar productos: en el CRM, botón **Reemplazar lista** con el
CSV nuevo (columnas `id,nombre,precio,categoria`; precio y categoría opcionales). Botón
**CSV** descarga la lista actual.

## Cambios en el bot (repo BlackStationBot)

Copia a `src/services/`:
- `crmAdapter.js` (agrega `searchProducts`).
- `productSearchFlow.js` (nuevo).
- `geminiService.js` (versión CRM-only, por si usas preguntas libres; el diccionario ya
  no va aquí).

En `messageHandler.js`:

```js
// arriba
import { buscarProductos, elegirProducto, enviarProductosEncontrados, ROW_PREFIX } from './productSearchFlow.js';
```

```js
// handleAssistantFlow: reemplaza TODO el método
async handleAssistantFlow(to, message) {
  const state = this.assistantState[to];
  delete this.assistantState[to];
  if (state?.step !== 'question') {
    await whatsappService.sendMessage(to, 'Lo siento 😔 no entendí tu respuesta\nPor Favor, elige una de las opciones del menú.');
    return;
  }
  await buscarProductos(to, message, this.assistantState);
}
```

```js
// handleAssistant (cuando el cliente escribe con ¿?): reemplaza TODO el método
async handleAssistant(userId, message) {
  try {
    await buscarProductos(userId, message, this.assistantState);
  } catch (error) {
    console.error('Error en handleAssistant:', error);
    printDetailedError(error);
    await whatsappService.sendMessage(userId, 'Lo siento, estoy teniendo problemas técnicos. Intenta nuevamente 🔧');
  }
}
```

```js
// handleProductSelection: reemplaza TODO el método
async handleProductSelection(to, rowId) {
  const ok = await elegirProducto(to, rowId, this.assistantState);
  if (!ok) await this.handleMenuOption(to, rowId);
}
```

```js
// procesarRespuestaAsistente ('finalizar'): reemplaza TODO el método
async procesarRespuestaAsistente(to) {
  try {
    await enviarProductosEncontrados(to);
  } catch (error) {
    console.error('Error en procesarRespuestaAsistente:', error);
    printDetailedError(error);
    await whatsappService.sendMessage(to, 'Lo siento, hubo un error procesando tu solicitud 🔧');
  }
}
```

En `handleIncomingMessage`, el `list_reply` ya distingue `product_selection`; además,
por si el estado se perdió (reinicio del bot), puedes aceptar las filas por su prefijo:

```js
const option = message?.interactive?.list_reply?.id;
if (this.assistantState[message.from]?.step === 'product_selection' || String(option).startsWith(ROW_PREFIX)) {
  await this.handleProductSelection(message.from, option);
} else {
  await this.handleMenuOption(message.from, option);
}
```

Ya puedes borrar `assistantResponseMap`, el `import geminiService` si no usas preguntas
libres, y las variables `GEMINI_API_KEY` / `GEMINI_MODEL` del bot en Railway. Deja
`CRM_BASE_URL`, `CRM_API_KEY`, `CRM_PHONE_NUMBER_ID`, `CRM_MODE=gateway`.

## Comprobar

- CRM → Catálogo de productos → "Probar la búsqueda": `quiero una gaseosa postobón` debe
  devolver los Postobon con sus IDs.
- Por WhatsApp: `¿tienen cereales?` → lista con "7 Cereales x 60gr" → al tocarlo llega
  la tarjeta del producto del catálogo.
- Con la IA apagada en el CRM, el bot responde "Por ahora no puedo buscar productos".
