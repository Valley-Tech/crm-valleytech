import axios from "axios";
import config from '../../config/env.js';
import { CRM_MODE, crmEnabled, canBotReply, recordSent, sendViaCrm } from '../crmAdapter.js';

/**
 * Reemplazo de sendToWhatsApp: misma firma y mismas exportaciones que el
 * original (default + downloadImageFromMeta), así whatsappService.js y
 * messageHandler.js no cambian.
 *
 *  · gateway: todo sale por el CRM (el bot no toca la Cloud API para mensajes).
 *  · mirror : sale directo a Meta como antes, pero (1) se respeta la pausa del
 *             bot decidida en el CRM y (2) el mensaje se registra en el CRM.
 *
 * Como en el original, un error de Meta se relanza (throw) para que el flujo
 * que llamó decida qué hacer.
 */

// Descarga la imagen de WhatsApp usando el token de Meta (sin cambios).
export const downloadImageFromMeta = async (imageUrl) => {
    const accessToken = config.API_TOKEN; // O el nombre de tu token de WhatsApp
    const response = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        headers: {
            Authorization: `Bearer ${accessToken}`
        }
    });
    return response.data; // Buffer de la imagen
};

const sendToWhatsApp = async (data) => {
    const to = data.to;

    if (CRM_MODE === 'gateway' && crmEnabled) {
        return sendViaCrm(to, data);
    }

    // Modo espejo ----------------------------------------------------------
    if (to && data.status !== 'read' && !(await canBotReply(to))) {
        console.log(`[crm] ${to}: bot pausado desde el CRM; no se envía`);
        return null;
    }

    const baseUrl = `${config.BASE_URL}/${config.API_VERSION}/${config.BUSINESS_PHONE}/messages`;
    const headers = {
        Authorization: `Bearer ${config.API_TOKEN}`
    };

    try {
        const response = await axios({
            method: 'POST',
            url: baseUrl,
            headers: headers,
            data,
        });
        if (to && data.status !== 'read') recordSent(to, data, response.data); // no se espera: no frena al bot
        return response.data;
    } catch (error) {
        console.error('[meta] error enviando:', error.response?.status, JSON.stringify(error.response?.data ?? error.message));
        throw error;
    }
};

export default sendToWhatsApp;
