import whatsappService from './whatsappService.js';
import { searchProducts } from './crmAdapter.js';

/**
 * Flujo "buscar producto" de MerkCentro24 con la lista de productos del CRM.
 *
 * Antes: geminiService.js tenía quemado el diccionario product_names
 * (id → nombre) y se le pedía a Gemini dos veces (nombres para el cliente y
 * luego IDs para el "[SISTEMA]"). Ahora el CRM devuelve en UNA llamada los
 * productos que coinciden con sus IDs reales (product_retailer_id), y la lista
 * se edita en el CRM → Chatbots → IA y conocimiento → Catálogo de productos.
 *
 * Uso en messageHandler.js (ver GUIA-BUSQUEDA-PRODUCTOS.md):
 *   import { buscarProductos, elegirProducto, enviarProductosEncontrados } from './productSearchFlow.js';
 */

const NO_AI = 'Por ahora no puedo buscar productos 🙈\nElige una opción del menú o escribe *Hola* para volver a empezar.';
const NOT_FOUND = 'Lo siento, no encontré ningún producto relacionado con tu búsqueda 😔\nIntenta con otra palabra clave (marca, sabor o presentación).';
const CONFIRM = '¿Esto es lo que buscas?\n\nToca un producto de la lista para verlo, o *Sí, gracias* para recibir todos.';

const CONFIRM_BUTTONS = [
  { type: 'reply', reply: { id: 'finalizar', title: 'Si, Gracias 😊' } },
  { type: 'reply', reply: { id: 'buscar', title: 'No, corregir' } },
];

/** Prefijo de las filas de la lista: así se distingue de las opciones del menú. */
export const ROW_PREFIX = 'prod:';

/** Memoria corta: productos encontrados por número, para "Sí, gracias". */
const found = new Map();

const title = (s) => (s.length > 24 ? `${s.slice(0, 23).trim()}…` : s);
const price = (p) => (p.price != null ? `$${Number(p.price).toLocaleString('es-CO', { maximumFractionDigits: 0 })}` : undefined);

/**
 * Busca lo que escribió el cliente y le muestra la lista de coincidencias.
 * Devuelve true si mostró productos (y deja al cliente en product_selection).
 */
export async function buscarProductos(to, message, assistantState) {
  const result = await searchProducts(to, message);
  if (!result) {
    await whatsappService.sendMessage(to, NO_AI);
    return false;
  }
  if (result.none || !result.items?.length) {
    await whatsappService.sendMessage(to, NOT_FOUND);
    await whatsappService.sendInteractiveButtons(to, '¿Quieres intentar con otra palabra?', [
      { type: 'reply', reply: { id: 'buscar', title: 'Buscar de nuevo 🔎' } },
    ]);
    return false;
  }

  found.set(to, result.items);

  // WhatsApp admite 10 filas por lista: se parte en varias si hace falta.
  for (let i = 0; i < result.items.length; i += 10) {
    const chunk = result.items.slice(i, i + 10);
    await whatsappService.sendListMessage(to, {
      type: 'list',
      body: { text: i === 0 ? 'Productos encontrados:' : 'Más productos:' },
      action: {
        button: 'Productos',
        sections: [{
          rows: chunk.map((p) => ({
            id: `${ROW_PREFIX}${p.id}`.slice(0, 200),
            title: title(p.name),
            ...(price(p) ? { description: price(p) } : {}),
          })),
        }],
      },
    });
  }
  if (assistantState) assistantState[to] = { step: 'product_selection' };
  await whatsappService.sendInteractiveButtons(to, CONFIRM, CONFIRM_BUTTONS);
  return true;
}

/** El cliente tocó una fila de la lista: se envía ese producto del catálogo. */
export async function elegirProducto(to, rowId, assistantState) {
  if (assistantState) delete assistantState[to];
  const id = String(rowId ?? '').startsWith(ROW_PREFIX) ? rowId.slice(ROW_PREFIX.length) : null;
  if (!id) return false;
  await whatsappService.sendSingleProduct(to, id);
  found.delete(to);
  return true;
}

/** "Sí, gracias": se envían todos los productos encontrados. */
export async function enviarProductosEncontrados(to) {
  const items = found.get(to);
  if (!items?.length) {
    await whatsappService.sendMessage(to, 'No encontré tu búsqueda anterior. Escríbeme de nuevo lo que necesitas.');
    return false;
  }
  for (const p of items) await whatsappService.sendSingleProduct(to, p.id);
  found.delete(to);
  return true;
}
