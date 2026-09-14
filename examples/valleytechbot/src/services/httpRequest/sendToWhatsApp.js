import axios from 'axios';
import config from '../../config/env.js';
import { CRM_MODE, crmEnabled, canBotReply, recordSent, sendViaCrm } from '../crmAdapter.js';

/**
 * Reemplazo de sendToWhatsApp: misma firma, mismo uso desde whatsappService.
 *
 *  · gateway: todo sale por el CRM (el bot no toca la Cloud API).
 *  · mirror : sale directo a Meta como antes, pero (1) se respeta la pausa del
 *             bot decidida en el CRM y (2) el mensaje se registra en el CRM.
 *
 * A diferencia del original, un error de Meta se muestra completo en el log
 * (antes solo se hacía console.error(error) y se devolvía undefined).
 */
const sendToWhatsApp = async (data) => {
  const to = data.to;

  if (CRM_MODE === 'gateway' && crmEnabled) {
    return sendViaCrm(to, data);
  }

  // Modo espejo ------------------------------------------------------------
  if (to && data.status !== 'read' && !(await canBotReply(to))) {
    console.log(`[crm] ${to}: bot pausado desde el CRM; no se envía`);
    return null;
  }

  const url = `${config.BASE_URL}/${config.API_VERSION}/${config.BUSINESS_PHONE}/messages`;
  try {
    const response = await axios({
      method: 'POST',
      url,
      headers: { Authorization: `Bearer ${config.API_TOKEN}` },
      data,
    });
    if (to && data.status !== 'read') recordSent(to, data, response.data); // no se espera: no frena al bot
    return response.data;
  } catch (error) {
    console.error('[meta] error enviando:', error.response?.status, JSON.stringify(error.response?.data ?? error.message));
    return undefined;
  }
};

export default sendToWhatsApp;
