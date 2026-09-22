import dotenv from 'dotenv';
import crypto from 'node:crypto';

dotenv.config();

/**
 * Normaliza una clave PEM leída de una variable de entorno.
 *
 * Al pegar la clave en el .env o en Railway se suelen perder los saltos de
 * línea (quedan como "\n" literales) o se cuelan las comillas. OpenSSL 3
 * entonces responde `DECODER routines::unsupported`, que no dice nada útil.
 * Aquí se arregla antes de usarla, igual que ya se hace con la clave de Google.
 */
function normalizarPem(valor) {
  let pem = String(valor ?? '').trim();
  if ((pem.startsWith('"') && pem.endsWith('"')) || (pem.startsWith("'") && pem.endsWith("'"))) {
    pem = pem.slice(1, -1);
  }
  pem = pem.replace(/\\r/g, '').replace(/\\n/g, '\n').replace(/\r/g, '');
  return pem ? `${pem.trim()}\n` : '';
}

const PRIVATE_KEY = normalizarPem(process.env.PRIVATE_KEY);

// Aviso al arrancar: mejor enterarse aquí que cuando Meta llame al endpoint.
if (PRIVATE_KEY) {
  try {
    crypto.createPrivateKey({ key: PRIVATE_KEY, passphrase: process.env.PASSPHRASE });
    console.log('[flows] clave privada cargada correctamente ✅');
  } catch (error) {
    const codigo = error.code || error.message;
    console.error(`[flows] ❌ no se pudo leer la clave privada: ${codigo}`);
    if (codigo === 'ERR_OSSL_BAD_DECRYPT') {
      console.error('        La PASSPHRASE no coincide con la que usaste al crear private.pem.');
    } else {
      console.error('        Revisa PRIVATE_KEY: debe empezar por "-----BEGIN" y conservar los saltos de línea.');
    }
  }
} else {
  console.warn('[flows] PRIVATE_KEY vacío: el endpoint /flow no podrá descifrar.');
}

export default {
  WEBHOOK_VERIFY_TOKEN: process.env.WEBHOOK_VERIFY_TOKEN,
  API_TOKEN: process.env.API_TOKEN,
  BUSINESS_PHONE: process.env.BUSINESS_PHONE,
  API_VERSION: process.env.API_VERSION,
  SPREADSHEETID: process.env.SPREADSHEETID,
  PORT: process.env.PORT || 3002,
  BASE_URL: process.env.BASE_URL,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  APP_SECRET: process.env.APP_SECRET,
  PASSPHRASE: process.env.PASSPHRASE,
  PRIVATE_KEY,
  URL_BASE_WOMPI: process.env.URL_BASE_WOMPI,
  WOMPI_PUBLIC_KEY: process.env.WOMPI_PUBLIC_KEY,
  WOMPI_PRIVATE_KEY: process.env.WOMPI_PRIVATE_KEY,

  // --- Flows de WhatsApp -------------------------------------------------
  // Flow del pedido en línea (el que se abre al comprar del catálogo).
  FLOW_ID_PEDIDO: process.env.FLOW_ID_PEDIDO || '1490489532006105',
  // Flow del sorteo / tienda virtual (opción 2 del menú).
  FLOW_ID_SORTEO: process.env.FLOW_ID_SORTEO || '1490489532006105',

  // Catálogo de Meta (sincronizado desde Shopify). Normalmente llega en el
  // propio pedido (order.catalog_id); esto es solo respaldo.
  CATALOG_ID: process.env.CATALOG_ID || '',
  // Tienda Shopify de la que se sincroniza el catálogo. Sus productos publicados
  // se leen de /products.json (público) para nombrar variantes sin permisos de Meta.
  SHOPIFY_STORE_URL: process.env.SHOPIFY_STORE_URL || 'https://mishabellastore.com',
  // Consultar también la Graph API del catálogo (requiere Marketing API + catalog_management).
  CATALOG_LOOKUP_META: (process.env.CATALOG_LOOKUP_META ?? 'true') !== 'false',

  // --- Pedido ------------------------------------------------------------
  // Costo del domicilio. Si es 0, no se suma nada aunque el cliente dé dirección.
  COSTO_DOMICILIO: Number(process.env.COSTO_DOMICILIO || 0),
  // Hoja donde se guardan los pedidos (por defecto, la que ya usabas).
  SPREADSHEET_PEDIDOS: process.env.SPREADSHEET_PEDIDOS || '1tuenjbpcJFLjiWIhcTIqdIdGA5cvLA5xyDDVKG2hG08',
  // Números que reciben aviso de pedido nuevo, separados por coma.
  // Ej: NOTIFY_NUMBERS=573161763710,573225435157
  NOTIFY_NUMBERS: (process.env.NOTIFY_NUMBERS || '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean),
  // Plantilla aprobada para ese aviso. Sin plantilla, el aviso solo llega si
  // ese número escribió al bot en las últimas 24 h (regla de Meta).
  NOTIFY_TEMPLATE: process.env.NOTIFY_TEMPLATE || '',
  // Idioma con el que se creó esa plantilla en Meta (es_CO, es, es_MX…).
  NOTIFY_TEMPLATE_LANG: process.env.NOTIFY_TEMPLATE_LANG || 'es_CO',

  // --- Datos de pago del negocio (salen en el mensaje de transferencia) ---
  CUENTAS_BANCARIAS:
    process.env.CUENTAS_BANCARIAS ||
    `- *Bancolombia Ahorros:* 52300000966
- *Nequi, Daviplata, Transfiya, Rappipay:* 3157465456
- *Grupo Aval (Occidente, Bogotá, AVVillas):* 816-81550-0`,
};
