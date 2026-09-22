import whatsappService from './whatsappService.js';
import appendToSheet, { actualizarEstadoPedido, getAvailableNumbers, saveUserDataByNumber } from './googleSheetsService.js';
import geminiAiService from './GeminiService.js';
import { createWompiPaymentLink, getWompiTransactionStatus } from './wompiService.js';
import { describirPedido } from './catalogoProductos.js';
import { datosCliente } from './flowPedido.js';
import store from './sessionStore.js';
import config from '../config/env.js';

/**
 * Mishabella Store — lógica de conversación.
 *
 * Cambios respecto a la versión anterior:
 *
 *  · El pedido del catálogo ya no dispara una cadena de preguntas por texto:
 *    abre el Flow de WhatsApp (igual que Samuelito) y de ahí sale el medio de
 *    pago. La cadena por texto queda como respaldo si no hay Flow configurado.
 *  · El pedido en curso vive en `sessionStore` (por cliente), no en variables
 *    globales del controlador: dos personas pueden comprar a la vez.
 *  · Los medios de pago se interpretan por palabra clave, así el Flow puede
 *    decir "Efectivo o contra-entrega" o "Contraentrega" y el bot entiende.
 */

const pagosPendientes = {}; // id del link de Wompi -> { to, tipo }

/** 'efectivo' | 'transferencia' | 'pse' — tolerante a cómo esté escrito en el Flow. */
export function normalizarPago(valor) {
  const v = String(valor ?? '').toLowerCase();
  if (!v) return null;
  if (v.includes('transfer')) return 'transferencia';
  if (v.includes('pse') || v.includes('linea') || v.includes('línea') || v.includes('tarjeta')) return 'pse';
  if (v.includes('efectivo') || v.includes('contra')) return 'efectivo';
  return null;
}

const money = (valor) => `$${Number(valor || 0).toLocaleString('es-CO')}`;
const ahora = () => new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });

class MessageHandler {

  constructor() {
    this.appointmentState = {};
    this.hiringState = {};
    this.assistandState = {};
  }

  // =========================================================================
  //  Entrada de mensajes
  // =========================================================================

  async handleIncomingMessage(message, senderInfo) {
    if (message?.type === 'text') {
      const incomingMessage = message.text.body.toLowerCase().trim();
      console.log(`Mensaje recibido de ${message.from}: ${incomingMessage}`);
      if (this.isGreeting(incomingMessage)) {
        await this.sendWelcomeMessage(message.from, message.id, senderInfo);
        await this.sendWelcomeMenu(message.from);
      } else if (this.appointmentState[message.from]) {
        await this.handleAppointmentFlow(message.from, incomingMessage);
      } else if (this.assistandState[message.from]) {
        await this.handleAssistandFlow(message.from, incomingMessage);
      } else if (this.isQuestion(incomingMessage)) {
        this.assistandState[message.from] = { step: 'question' };
        await this.handleAssistandFlow(message.from, incomingMessage);
      } else {
        await this.handleMenuOption(message.from, incomingMessage);
      }
      await whatsappService.markAsRead(message.id);

    } else if (message?.type === 'interactive') {
      const tipo = message.interactive?.type;

      if (tipo === 'button_reply') {
        const option = message.interactive.button_reply?.id;
        // op_1/op_2/op_3 son el respaldo manual del medio de pago.
        if (['op_1', 'op_2', 'op_3'].includes(option)) {
          await this.respFlowBotones(message.from, option);
        } else {
          await this.handleMenuOption(message.from, option);
        }
        await whatsappService.markAsRead(message.id);

      } else if (tipo === 'nfm_reply') {
        await this.handleFlowReply(message);
        await whatsappService.markAsRead(message.id);
      }

    } else if (message?.type === 'order') {
      await this.handleOrder(message.from, message.order);
      await whatsappService.markAsRead(message.id);
    }
  }

  /**
   * Respuesta de un Flow terminado. El `flow_token` dice de qué Flow viene
   * (`pedido:...` o `sorteo:...`), así los dos conviven sin pisarse.
   */
  async handleFlowReply(message) {
    const to = message.from;
    let respuesta = {};
    try {
      respuesta = JSON.parse(message.interactive?.nfm_reply?.response_json ?? '{}');
    } catch {
      respuesta = {};
    }

    const token = respuesta.flow_token;
    const sesion = store.getByToken(token) ?? store.getByPhone(to, 'pedido') ?? store.getByPhone(to, 'sorteo');

    if (!sesion) {
      console.warn('[flow] respuesta sin sesión conocida:', token);
      await whatsappService.sendMessage(to, 'Recibimos tu formulario 🙌 Un asesor te confirma en un momento.');
      return;
    }

    if (sesion.kind === 'sorteo') {
      await this.respFlowSorteo(to, sesion);
    } else {
      await this.respFlow(to, sesion);
    }
  }

  isGreeting(message) {
    const greetings = ["hola", "hi", "ok", "listo", "bien", "bueno", "hello", "HL", "Oe", "buenas", "buenos dias", "buenas tardes", "buenas noches", "saludos", "como estás", "hl", "gracias", "muchas gracias"];
    return greetings.includes(message);
  }

  isQuestion(message) {
    const lower = message.toLowerCase();
    return (
      lower.includes('que') ||
      lower.includes('qué') ||
      lower.includes('quiero') ||
      lower.includes('quisiera') ||
      lower.includes('necesito') ||
      lower.includes('quien') ||
      lower.includes('quién') ||
      lower.includes('cual') ||
      lower.includes('cuál') ||
      lower.includes('cuando') ||
      lower.includes('cuándo') ||
      lower.includes('porque') ||
      lower.includes('por que') ||
      lower.includes('porqué') ||
      lower.includes('por qué') ||
      lower.includes('para que') ||
      lower.includes('para qué') ||
      lower.includes('donde') ||
      lower.includes('dónde') ||
      lower.includes('como') ||
      lower.includes('cómo') ||
      lower.includes('cuanto') ||
      lower.includes('cuánto') ||
      lower.includes('pregunta') ||
      lower.includes('¿') ||
      lower.includes('?')
    );
  }

  getSenderName(senderInfo) {
    return senderInfo?.profile?.name || senderInfo?.wa_id || "Cliente";
  }

  // =========================================================================
  //  Menús
  // =========================================================================

  async sendWelcomeMessage(to, messageId, senderInfo) {
    const name = this.getSenderName(senderInfo);
    const welcomeMessage = `¡Hola 🤗 ${name}!\nBienvenid@ a *Mishabella Store* 🛍\n\n¿En qué te puedo ayudar? 🤔`;
    await whatsappService.sendMessage(to, welcomeMessage, messageId);
  }

  async sendWelcomeMenu(to) {
    const menuMessage = "Elige una Opción"
    const buttons = [
      { type: 'reply', reply: { id: 'option_1', title: 'Comprar 🛒' } },
      { type: 'reply', reply: { id: 'option_2', title: 'Tienda Virtual 🛍️' } },
      // { type: 'reply', reply: { id: 'option_3', title: 'Habla con mIA 🤖' } }
    ];

    await whatsappService.sendInteractiveButtons(to, menuMessage, buttons);
  }

  /** Respaldo manual del medio de pago (solo si no hay Flow configurado). */
  async menuOpcional(to) {
    const menuMessage = "Elige tu medio de pago:"
    const buttons = [
      { type: 'reply', reply: { id: 'op_1', title: 'Efectivo' } },
      { type: 'reply', reply: { id: 'op_2', title: 'Transferencia' } },
      { type: 'reply', reply: { id: 'op_3', title: 'En linea PSE' } }
    ];

    await whatsappService.sendInteractiveButtons(to, menuMessage, buttons);
  }

  /** Flow de la tienda virtual / sorteo (opción 2). */
  async menuUrl(to) {
    const spreadsheetId = config.SPREADSHEETID;
    const availableNumbers = await getAvailableNumbers(spreadsheetId);

    if (availableNumbers.length === 0) {
      await whatsappService.sendMessage(
        to,
        "❌ No hay boletas disponibles en este momento. ¡Intenta más tarde!"
      );
      return;
    }

    const chipsData = availableNumbers.map((num) => ({ id: String(num), title: String(num) }));
    const sesion = store.createSorteo(to);

    const action = {
      name: "flow",
      parameters: {
        flow_message_version: "3",
        flow_id: config.FLOW_ID_SORTEO,
        flow_token: sesion.token,
        flow_cta: "¡QUIERO PARTICIPAR!",
        flow_action: "navigate",
        flow_action_payload: {
          screen: "PRINCIPAL",
          data: { available_numbers: chipsData },
        },
      },
    };
    await whatsappService.sendUrl(to, action);
  }

  /**
   * Flow del PEDIDO. Se abre después de que el cliente manda su pedido desde
   * el catálogo. El `flow_token` es el que permite recuperar ese pedido
   * cuando el Flow vuelve con los datos de envío.
   */
  async menuPedido(to, token) {
    const action = {
      name: "flow",
      parameters: {
        "flow_message_version": "3",
        "flow_id": config.FLOW_ID_PEDIDO,
        "flow_token": token,
        "flow_cta": "Pedido"
      },
    };
    return await whatsappService.sendFlow(to, action, "Datos de envío:", "Haz clic aquí 👇");
  }

  async catalogo(to) {
    const template = {
      name: "catalogos_productos",
      language: { code: "Es_Co" },
      components: [
        { type: "button", sub_type: "CATALOG", index: 0 }
      ]
    };
    await whatsappService.sendMenu(to, template);
  }

  waiting = (delay, callback) => {
    setTimeout(callback, delay);
  };

  async handleMenuOption(to, option) {
    let response;
    switch (option) {
      case 'option_1':
        await this.catalogo(to);
        break;
      case 'option_2':
        this.hiringState[to] = { step: 'boleta' };
        await this.menuUrl(to);
        break;
      case 'option_3':
        this.assistandState[to] = { step: 'question' };
        response = 'Realiza tu pregunta: ';
        break;
      case 'option_4':
        response = "Te esperamos en nuestro Local!"
        await this.sendLocation(to);
        break;
      case 'option_5':
        response = "Para hablar con un asesor escribe al siguiente contacto"
        await this.sendContact(to);
        break;
      default:
        response = "Oops😔\nPorfa, elige una de las opciones del menú o escribe *Hola* para volver a empezar\nTambién, escribe *Ayuda* para más opciones.";
    }
    if (response) {
      await whatsappService.sendMessage(to, response);
    }
  }

  // =========================================================================
  //  Compra en línea: catálogo → Flow → medio de pago
  // =========================================================================

  /**
   * Llega un pedido del catálogo. Se guarda la sesión del cliente y se le
   * abre el Flow con los datos de envío.
   */
  async handleOrder(to, order) {
    const items = order?.product_items ?? [];
    if (items.length === 0) {
      await whatsappService.sendMessage(to, 'No pudimos leer tu pedido 😕 Intenta enviarlo de nuevo desde el catálogo.');
      return;
    }

    // Consulta el catálogo de Meta (Shopify) para poner nombre y variante a cada id.
    const pedido = await describirPedido(order);
    const sesion = store.createOrder(to, {
      items: pedido.items,          // enriquecidos: nombre, variante, grupo, cantidad, precio
      total: pedido.total,
      pedidoStr: pedido.pedidoStr,
      currency: pedido.items[0]?.moneda ?? 'COP',
      catalogId: pedido.catalogId,
    });

    await this.handlePedido(to, pedido.pedidoStr, pedido.total, sesion);
  }

  /**
   * Muestra el resumen y abre el Flow del pedido.
   * Si no hay Flow configurado, cae al respaldo por texto (como antes).
   */
  async handlePedido(to, pedidoStr, total, sesion) {
    const resumen = `*Resumen de tu Compra* 🛒\n\n${pedidoStr}\n\n*Total:* ${money(total)} COP`;
    await whatsappService.sendMessage(to, resumen);

    if (config.FLOW_ID_PEDIDO) {
      await this.menuPedido(to, sesion.token);
      return;
    }

    // Respaldo: la cadena de preguntas por texto de la versión anterior.
    console.warn('[pedido] sin FLOW_ID_PEDIDO: se usa el flujo por texto');
    this.appointmentState[to] = { step: 'datos', token: sesion.token };
    await whatsappService.sendMessage(
      to,
      'Para continuar con tu compra danos los siguientes datos por favor:\n\n*Nombre completo:*'
    );
  }

  /** Respaldo por texto (solo si no hay Flow). Misma secuencia de siempre. */
  async handleAppointmentFlow(to, message) {
    const state = this.appointmentState[to];
    let response;

    switch (state.step) {
      case 'pedido':
        state.step = 'datos';
        response = "Para continuar con tu compra danos los siguientes datos por favor:\n\n*Nombre completo:*";
        break;
      case 'datos':
        state.nombre = message;
        state.step = 'nombre';
        response = `*Celular de contacto:* `;
        break;
      case 'nombre':
        state.celular = message;
        state.step = 'direccion';
        response = '*Ingresa tu dirección completa:* ';
        break;
      case 'direccion':
        state.direccion = message;
        state.step = 'mediopago';
        await this.menuOpcional(to);
        break;
      default:
        response = "Lo siento 😔 no entendí tu respuesta\nPor Favor, elige una de las opciones del menú.";
    }
    if (response) {
      await whatsappService.sendMessage(to, response);
    }
  }

  /**
   * El cliente terminó el Flow del pedido: aquí se decide qué responder según
   * el medio de pago y se guarda el pedido en la hoja.
   */
  async respFlow(to, sesion) {
    const datos = datosCliente(sesion.datos ?? {});
    const pedidoStr = sesion.pedidoStr ?? '';
    const domicilio = sesion.domicilio ?? (datos.address ? config.COSTO_DOMICILIO : 0);
    const total = Number(sesion.total ?? 0) + domicilio;
    const medio = normalizarPago(datos.pago);

    const cabecera = `*Resumen de tu pedido* 🛒\n\n${pedidoStr}\n\n*Total:* ${money(total)} COP${domicilio > 0 ? ` (incluye domicilio ${money(domicilio)})` : ''}`;
    let response;
    let estado;

    if (medio === 'efectivo') {
      estado = 'Contra entrega';
      response = `${cabecera}\n\n✅ *¡Pedido recibido!*\nPagas en *efectivo al recibir* 💵\n\nPronto nos comunicamos contigo para coordinar la entrega 🤗`;

    } else if (medio === 'transferencia') {
      estado = 'Por confirmar (transferencia)';
      response = `${cabecera}\n\n*Proceso de pago* 🏦💳\n\nTransfiere ${money(total)} a alguna de estas cuentas:\n\n${config.CUENTAS_BANCARIAS}\n\n📸 *Envíanos el comprobante por aquí mismo* para confirmar tu pedido 😊`;

    } else if (medio === 'pse') {
      estado = 'Pendiente de pago';
      try {
        const idlink = await createWompiPaymentLink(total * 100, 'COP', `Mishabella Store - ${datos.name ?? to}`);
        pagosPendientes[idlink] = { to, tipo: 'pedido' };
        response = `${cabecera}\n\nUtiliza el siguiente *link de pago*:\n\nhttps://checkout.wompi.co/l/${idlink}\n\nAl realizar el pago te lo confirmamos automáticamente 😊`;
      } catch (error) {
        console.error('[pedido] error creando el link de Wompi:', error.message);
        estado = 'Error link de pago';
        response = `${cabecera}\n\nHubo un problema al generar el enlace de pago 😕 Puedes pagar por transferencia:\n\n${config.CUENTAS_BANCARIAS}`;
      }

    } else {
      // El Flow no mandó medio de pago (o llegó con un texto que no reconocemos).
      console.warn('[pedido] medio de pago no reconocido:', datos.pago);
      estado = 'Sin medio de pago';
      response = `${cabecera}\n\nRecibimos tus datos 🙌 Elige cómo quieres pagar:`;
      await whatsappService.sendMessage(to, response);
      await this.menuOpcional(to);
      await this.completeOrder(to, { datos, pedidoStr, total, medio: 'Por definir', estado });
      return;
    }

    await whatsappService.sendMessage(to, response);
    await this.completeOrder(to, { datos, pedidoStr, total, medio: datos.pago ?? medio, estado });

    if (medio !== 'pse') store.clearSession(sesion.token);
  }

  /** Respaldo: el cliente eligió el medio de pago con los botones op_1/2/3. */
  async respFlowBotones(to, opcion) {
    const sesion = store.getByPhone(to, 'pedido');
    const state = this.appointmentState[to] ?? {};
    const pedidoStr = sesion?.pedidoStr ?? '';
    const total = Number(sesion?.total ?? 0);

    const datos = {
      name: state.nombre ?? '',
      phone: state.celular ?? to,
      address: state.direccion ?? '',
      pago: opcion === 'op_1' ? 'Efectivo' : opcion === 'op_2' ? 'Transferencia' : 'En linea PSE',
    };

    delete this.appointmentState[to];

    if (sesion) {
      store.setFlowData(sesion.token, 'BOTONES', datos);
      await this.respFlow(to, { ...sesion, datos });
      return;
    }

    // Sin pedido en memoria: al menos se responde con los datos de pago.
    const medio = normalizarPago(datos.pago);
    const response = medio === 'transferencia'
      ? `*Proceso de pago* 🏦💳\n\nTransfiere a alguna de estas cuentas:\n\n${config.CUENTAS_BANCARIAS}\n\n📸 Envíanos el comprobante para confirmar tu pedido.`
      : '✅ ¡Recibido!\nPronto nos pondremos en contacto contigo 🤗';
    await whatsappService.sendMessage(to, response);
    await this.completeOrder(to, { datos, pedidoStr, total, medio: datos.pago, estado: 'Manual' });
  }

  /** Guarda el pedido en la hoja de cálculo. */
  async completeOrder(to, { datos = {}, pedidoStr = '', total = 0, medio = '', estado = '' }) {
    try {
      const fila = [
        to,                      // A  WhatsApp
        datos.name ?? '',        // B  Nombre
        pedidoStr,               // C  Pedido
        datos.phone ?? '',       // D  Celular
        datos.address ?? '',     // E  Dirección
        medio,                   // F  Medio de pago
        ahora(),                 // G  Fecha
        total,                   // H  Total
        estado,                  // I  Estado
        datos.recomendacion ?? '' // J  Recomendaciones
      ];
      await appendToSheet(fila, config.SPREADSHEET_PEDIDOS);
      await this.notificarPedido({ to, datos, pedidoStr, total, medio });
    } catch (error) {
      console.error('[pedido] no se pudo guardar en la hoja:', error.message);
    }
  }

  /** Aviso al negocio de que entró un pedido (opcional, ver NOTIFY_NUMBERS). */
  async notificarPedido({ to, datos, pedidoStr, total, medio }) {
    if (config.NOTIFY_NUMBERS.length === 0) return;

    const variables = [
      datos.name ?? '',
      datos.phone ?? to,
      datos.address ?? 'Sin dirección',
      pedidoStr,
      medio,
      money(total),
    ];

    if (!config.NOTIFY_TEMPLATE) {
      // Sin plantilla, Meta solo entrega si ese número le escribió al bot en las
      // últimas 24 h; si no, el mensaje queda "failed / Re-engagement message"
      // (error 131047). Para avisos confiables crea la plantilla y ponla en
      // NOTIFY_TEMPLATE (ver README, "Aviso de pedido nuevo").
      console.warn('[pedido] NOTIFY_TEMPLATE vacío: el aviso solo llega si el número escribió al bot hace menos de 24 h');
    }

    for (const numero of config.NOTIFY_NUMBERS) {
      try {
        if (config.NOTIFY_TEMPLATE) {
          await whatsappService.sendTemplateVariables(numero, config.NOTIFY_TEMPLATE, variables, null, config.NOTIFY_TEMPLATE_LANG);
        } else {
          await whatsappService.sendMessage(
            numero,
            `🛒 *Pedido nuevo*\n\n*Cliente:* ${variables[0]}\n*Celular:* ${variables[1]}\n*Dirección:* ${variables[2]}\n\n${pedidoStr}\n\n*Pago:* ${medio}\n*Total:* ${money(total)}`
          );
        }
      } catch (error) {
        // El pedido ya está en la hoja: un aviso fallido no debe frenar al resto.
        console.error(`[pedido] no se pudo avisar a ${numero}:`, error.response?.data?.error?.message ?? error.message);
      }
    }
  }

  // =========================================================================
  //  Sorteo / tienda virtual (se conserva)
  // =========================================================================

  async respFlowSorteo(to, sesion) {
    const datos = sesion?.datos ?? {};
    let response;

    let boletasArray = [];
    if (Array.isArray(datos.boleta)) {
      boletasArray = datos.boleta.map((b) => String(b).trim());
    } else if (typeof datos.boleta === "string") {
      boletasArray = datos.boleta.split(",").map((b) => b.trim()).filter((b) => b !== "");
    } else if (typeof datos.boleta === "number") {
      boletasArray = [String(datos.boleta)];
    }

    const totalBoletas = boletasArray.length;
    const valorUnitario = 5000;
    const totalAPagar = totalBoletas * valorUnitario;
    const montoCentavos = totalAPagar * 100;

    if (montoCentavos < 150000) {
      await whatsappService.sendMessage(
        to,
        "El monto mínimo para pagar por WOMPI es $1,500 COP. Por favor, selecciona más boletas."
      );
      return;
    }

    if (normalizarPago(datos.pago) === 'pse') {
      try {
        const descripcion = `Sorteo Chatbot - ${datos.name} - Boletas: ${boletasArray.join(", ")}`;
        const idlink = await createWompiPaymentLink(montoCentavos, "COP", descripcion);
        pagosPendientes[idlink] = { to, tipo: 'sorteo' };
        response = `*Resumen de tu compra💳:*

*Nombre:* ${datos.name}
*Números escogidos:* ${boletasArray.join(", ")}
*Total a pagar:* ${money(totalAPagar)} COP

Utiliza el siguiente *link de pago*:
https://checkout.wompi.co/l/${idlink}

Al realizar el pago, automáticamente te lo confirmamos! 😊`;
      } catch (error) {
        console.error("Error WOMPI:", error);
        response = "Hubo un problema al generar el enlace de pago. Por favor, intenta nuevamente.";
      }
    } else {
      response = `*Resumen de tu compra💳:*

*Nombre:* ${datos.name}
*Números escogidos:* ${boletasArray.join(", ")}
*Total a transferir:* ${money(totalAPagar)} COP

Transfiere ${money(totalAPagar)} en alguno de los siguientes *medios de pago* 🏦💳:

${config.CUENTAS_BANCARIAS}

*Por favor, envíanos el comprobante de pago al siguiente Whatsapp para confirmar*.`;
      await this.sendContact(to);
    }

    this.completeHiring(to, { ...datos, boleta: boletasArray.join(", ") });
    await whatsappService.sendMessage(to, response);
  }

  completeHiring(to, data) {
    const spreadsheetId = config.SPREADSHEETID;
    const userData = [
      to,
      data.boleta,
      data.name,
      data.phone,
      data.address,
      data.bussines,
      ahora(),
      data.pago
    ];
    this.hiringState[to] = { ...(this.hiringState[to] ?? {}), userData };

    saveUserDataByNumber(userData, spreadsheetId);
  }

  /** Respaldo por texto del pedido manual (se conserva). */
  completeAppointment(to, pedidoStr, medioPago) {
    const appointment = this.appointmentState[to] ?? {};
    delete this.appointmentState[to];

    const userData = [
      to,
      appointment.nombre ?? '',
      pedidoStr,
      appointment.celular ?? '',
      appointment.direccion ?? '',
      medioPago,
      ahora()
    ];

    appendToSheet(userData, config.SPREADSHEET_PEDIDOS);
  }

  // =========================================================================
  //  Wompi
  // =========================================================================

  async handleWompiEvent(transaction) {
    try {
      const transactionId = transaction.id;
      const paymentLinkId = transaction.payment_link_id;
      const pendiente = pagosPendientes[paymentLinkId];
      const phone = pendiente?.to;

      if (!phone) {
        console.error("No se encontró el número de WhatsApp para la transacción:", paymentLinkId);
        return;
      }

      let status;
      try {
        status = await getWompiTransactionStatus(transactionId);
      } catch (error) {
        console.error("Error consultando el estado de la transacción:", error);
        return;
      }

      const estadoPago = status === "APPROVED" ? "Confirmado" : "Pendiente";

      if (pendiente.tipo === 'sorteo') {
        // Sorteo: se actualiza la fila de la boleta.
        const datosActual = this.hiringState[phone]?.userData;
        if (datosActual) {
          datosActual.estado = estadoPago;
          await saveUserDataByNumber(datosActual, config.SPREADSHEETID);
          delete this.hiringState[phone];
        } else {
          console.error("No se encontraron datos de usuario para el número:", phone);
        }
      } else {
        // Pedido: se actualiza el estado en la hoja de pedidos.
        await actualizarEstadoPedido(phone, estadoPago, config.SPREADSHEET_PEDIDOS);
        const sesion = store.getByPhone(phone, 'pedido');
        if (sesion && status === "APPROVED") store.clearSession(sesion.token);
      }

      let statusMsg;
      if (status === "APPROVED") {
        statusMsg = pendiente.tipo === 'sorteo'
          ? "¡Pago aprobado!✅\nMuchas gracias por participar en nuestro sorteo 😊 Te deseamos mucha suerte 🍀\n\nPronto nos pondremos en contacto contigo."
          : "¡Pago aprobado!✅\nGracias por tu compra en *Mishabella Store* 🛍\n\nYa estamos preparando tu pedido 🤗";
      } else if (status === "DECLINED") {
        statusMsg = "❌ El pago fue rechazado\nPor favor, revisa tu transacción o intenta nuevamente.";
      } else if (status === "VOIDED") {
        statusMsg = "⚠️ El pago fue anulado\nSi tienes dudas, contáctanos.";
      } else if (status === "ERROR") {
        statusMsg = "⚠️ Tu método de pago está presentando Error.\nPor favor, revísalo e intenta nuevamente.";
      } else if (status === "PENDING") {
        statusMsg = "⏳ Tu pago está pendiente de confirmación.\nTe avisaremos cuando se apruebe.";
      } else {
        statusMsg = `El estado de tu transacción es: ${status}`;
      }

      if (status !== "PENDING") delete pagosPendientes[paymentLinkId];
      await whatsappService.sendMessage(phone, statusMsg);

    } catch (error) {
      console.error("Error en handleWompiEvent:", error);
    }
  }

  // =========================================================================
  //  Asistente y datos del negocio
  // =========================================================================

  async sendMediaEvento(to) {
    const mediaUrl = 'https://sorteo-chatbot.s3.us-east-1.amazonaws.com/%C2%A1Sorteo+Chatbot!.png';
    const caption = '¡Sorteo Chatbot!';
    const type = 'image';

    await whatsappService.sendMediaMessage(to, type, mediaUrl, caption);
  }

  async handleAssistandFlow(to, message) {
    const state = this.assistandState[to];
    let response;

    const menuMessage = "¿Resolví tu pregunta?"
    const buttons = [
      { type: 'reply', reply: { id: 'option_4', title: "Si, Gracias" } },
      { type: 'reply', reply: { id: 'option_3', title: 'Hacer otra pregunta' } },
      { type: 'reply', reply: { id: 'option_5', title: 'Asesor' } }
    ];

    if (state.step === 'question') {
      // Se pasa el número como id de sesión: antes iba vacío y todos los
      // clientes compartían el mismo historial con Gemini.
      response = await geminiAiService(message, to);
    }

    delete this.assistandState[to];
    await whatsappService.sendMessage(to, response);
    await whatsappService.sendInteractiveButtons(to, menuMessage, buttons);
  }

  async sendContact(to) {
    const contact = {
      addresses: [
        {
          street: "Carrera 7 #9-60",
          city: "La Loma",
          state: "Cesar",
          zip: "201038",
          country: "Colombia",
          country_code: "CO",
          type: "WORK"
        }
      ],
      emails: [
        {
          email: "johcastro1610@hotmail.com",
          type: "WORK"
        }
      ],
      name: {
        formatted_name: "ValleyTech",
        first_name: "Valley",
        last_name: "Tech",
        middle_name: "",
        suffix: "",
        prefix: ""
      },
      org: {
        company: "ValleyTech",
        department: "Atención al Cliente",
        title: "Representante"
      },
      phones: [
        {
          phone: "+573161763710",
          wa_id: "573161763710",
          type: "WORK"
        }
      ],
      urls: [
        {
          url: "https://johntech-loma.github.io/",
          type: "WORK"
        }
      ]
    };

    await whatsappService.sendContactMessage(to, contact);
  }

  async sendLocation(to) {
    const latitude = 9.6213894;
    const longitude = -73.5877435;
    const name = 'GanoExcel La Loma';
    const address = 'Cra. 7 #9 - 60, La Loma, Cesar, Colombia.'

    await whatsappService.sendLocationMessage(to, latitude, longitude, name, address);
  }

}

export default new MessageHandler();
