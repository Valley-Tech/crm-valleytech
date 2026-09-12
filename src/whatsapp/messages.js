import { graphRequest } from './graph.js';

/**
 * Construye el payload de la Cloud API a partir del formato interno del CRM.
 * Formato interno: { type, text?, template?, interactive?, media? }
 */
export function buildPayload(to, message) {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to };

  switch (message.type) {
    case 'text':
      return { ...base, type: 'text', text: { body: message.text, preview_url: message.previewUrl ?? false } };

    case 'template':
      return {
        ...base,
        type: 'template',
        template: {
          name: message.template.name,
          language: { code: message.template.language ?? 'es' },
          components: message.template.components ?? [],
        },
      };

    case 'interactive':
      return { ...base, type: 'interactive', interactive: message.interactive };

    case 'image':
    case 'document':
    case 'audio':
    case 'video':
    case 'sticker':
      return { ...base, type: message.type, [message.type]: message.media };

    case 'reaction':
      return { ...base, type: 'reaction', reaction: message.reaction };

    case 'location':
      return { ...base, type: 'location', location: message.location };

    default:
      throw new Error(`Tipo de mensaje no soportado: ${message.type}`);
  }
}

/** Envía y devuelve el wamid. Lanza MetaApiError si Meta rechaza. */
export async function sendMessage({ phoneNumberId, accessToken, to, message }) {
  const payload = buildPayload(to, message);
  const data = await graphRequest({
    method: 'POST',
    path: `${phoneNumberId}/messages`,
    accessToken,
    data: payload,
  });

  return { waMessageId: data?.messages?.[0]?.id ?? null, raw: data, payload };
}

/** Marca un mensaje entrante como leído (los dos checks azules del cliente). */
export async function markAsRead({ phoneNumberId, accessToken, waMessageId }) {
  return graphRequest({
    method: 'POST',
    path: `${phoneNumberId}/messages`,
    accessToken,
    data: { messaging_product: 'whatsapp', status: 'read', message_id: waMessageId },
  });
}
