import sendToWhatsApp from './sendToWhatsApp.js';

class WhatsAppService {
  /**
   * @param {string} phoneNumberId - Phone Number ID del tenant
   * @param {string} accessToken - Token del tenant, ya descifrado
   */
  async sendText(phoneNumberId, accessToken, to, body) {
    const data = {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body, preview_url: false },
    };
    return sendToWhatsApp(data, phoneNumberId, accessToken);
  }

  async sendTemplate(phoneNumberId, accessToken, to, templateName, languageCode = 'es', components = []) {
    const data = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components,
      },
    };
    return sendToWhatsApp(data, phoneNumberId, accessToken);
  }

  async sendInteractiveButtons(phoneNumberId, accessToken, to, bodyText, buttons) {
    const data = {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: {
          buttons: buttons.map((b) => ({
            type: 'reply',
            reply: { id: b.id, title: b.title },
          })),
        },
      },
    };
    return sendToWhatsApp(data, phoneNumberId, accessToken);
  }

  async sendMedia(phoneNumberId, accessToken, to, mediaType, mediaPayload) {
    // mediaType: image | document | audio | video
    // mediaPayload: { link } o { id }, y opcionalmente { caption }
    const data = {
      messaging_product: 'whatsapp',
      to,
      type: mediaType,
      [mediaType]: mediaPayload,
    };
    return sendToWhatsApp(data, phoneNumberId, accessToken);
  }
}

export default new WhatsAppService();
