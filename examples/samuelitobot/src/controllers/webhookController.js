import config from '../config/env.js';
import { decryptRequest, encryptResponse, FlowEndpointException } from "../services/encryption.js";
import { getNextScreen } from "../services/flow.js";
import { nextScreen } from "../services/flowReserva.js";
import { nextEncuesta } from "../services/flowEncuesta.js";
import messageHandler from '../services/messageHandler.js';
import crypto from "crypto";
import { CRM_MODE, forwardWebhook, toMetaMessage } from '../services/crmAdapter.js';

const privateKey = config.PRIVATE_KEY;
function isRequestSignatureValid(req) {
  if(!config.APP_SECRET) {
    console.warn("App Secret is not set up. Please Add your app secret in /.env file to check for request validation");
    return true;
  }
  
  const signatureHeader = req.get("x-hub-signature-256");
  const signatureHeaderSha = signatureHeader.replace("sha256=", "");
  const signatureBuffer = Buffer.from(signatureHeaderSha, "utf-8");
  
  const hmac = crypto.createHmac("sha256", config.APP_SECRET);
  const digestString = hmac.update(req.rawBody).digest('hex');
  const digestBuffer = Buffer.from(digestString, "utf-8");

  if ( !crypto.timingSafeEqual(digestBuffer, signatureBuffer)) {
    return false;
  }
  return true;
}

let ventana;
let datosReserva;
let datosPedido = {};
let productos;
let precioTotal = 0;
let pedidoStr;
const idNumber = {}
class WebhookController {  
  /**
   * Webhook de Meta (modo espejo). Se reenvía al CRM ANTES del filtro por
   * número para que el CRM vea también estados y eventos. Se responde 200
   * enseguida: Meta reintenta (y duplica) si el bot tarda en contestar.
   */
  async handleIncoming(req, res) {
    if (CRM_MODE !== 'gateway') forwardWebhook(req.body); // sin await: no frena la respuesta a Meta

    const message = req.body.entry?.[0]?.changes[0]?.value?.messages?.[0];
    const recipientPhone = req.body.entry?.[0]?.changes[0]?.value?.metadata?.phone_number_id;

    // Solo responde si el mensaje es para el número de este bot
    if (recipientPhone !== process.env.BUSINESS_PHONE) {
      return res.sendStatus(200); // Ignora el mensaje
    }
    const senderInfo = req.body.entry?.[0]?.changes[0]?.value?.contacts?.[0];
    res.sendStatus(200);
    if (message) await this.dispatch(message, senderInfo);
  }

  /**
   * Evento del CRM (modo gateway): el CRM ya guardó el mensaje y comprobó que
   * el bot está activo en esa conversación. Se reconstruye el mensaje con el
   * formato de Meta y se entra por la misma lógica de siempre.
   */
  async handleCrmEvent(event) {
    if (event.event !== 'message.received' || !event.message) return;
    // Doble seguro: el CRM ya filtra por "Atiende", pero si BUSINESS_PHONE está definido solo se atiende ese número.
    if (process.env.BUSINESS_PHONE && event.integration?.phoneNumberId && event.integration.phoneNumberId !== process.env.BUSINESS_PHONE) return;
    const { message, senderInfo } = toMetaMessage(event);
    await this.dispatch(message, senderInfo);
  }

  /** La lógica original de handleIncoming, intacta, usada por los dos caminos. */
  async dispatch(message, senderInfo) {
    try {
      idNumber["numero"] = message.from;
      if (message?.type === 'interactive' && message?.interactive.type === 'nfm_reply') {
        await messageHandler.handleIncomingMessage(message, senderInfo, ventana, datosReserva, datosPedido, pedidoStr);
      }
      else if (message?.type === 'order') {
      const product_names = {
        "5de86e87205aba0e1c990910" : "Chips de Plátano con Suero",
        "654ffcee0779b105ec6ac3bd" : "Patacones de la Casa",
        "5dbcae51c557e50e67febfcc" : "Don Chicharrón",
        "5dbcad3fc557e50e67febfac" : "Canastas del Mar",
        "5dbcae00c557e50e67febfc0" : "Cóctel de Camarones",
        "5dbcb083c557e50e67febfdb" : "Chorizo Artesanal",
        "6888523e6fb8ea242c06a0bb" : "Chorizo Mexicano",
        "67981c57bd2f74e33cfce707" : "Baby en Salsa de Champiñones",
        "66ef02fa4ff68adb785f09f8" : "Lomo imperial con Fettuccine a los 4 Quesos",
        "619e8bd01880235f6d5b27e5" : "Lomito Mar y Tierra",
        "5dbcb308c557e50e67febff9" : "Baby Beef",
        "5dbcb38cc557e50e67febffc" : "Churrasco de Res",
        "5dc733ad7c14810dfd3fec3f" : "Churrasco de Cerdo",
        "68203e8d7f735e5e48b7ec3b" : "Churrasco de Cerdo en Salsa con Tocineta",
        "5e5ae290338d200e065c3577" : "Steak Pimienta",
        "67981d4d8460dcaf720f2284" : "Burger La Nuestra",
        "5dcf187deea63f0df843be1e" : "Cazuela de Mariscos",
        "5dbcb3d9c557e50e67fec005" : "Costillas BBQ Premium",
        "6311736932c31c05fbf10f89" : "Churrasco de Cerdo Gratinado",
        "5dbcb5a6c557e50e67fec022" : "Pechuga al Grill",
        "5de84c6e205aba0e1c9907d0" : "Pechuga Gratinada",
        "68203ef70ae0923d28d06765" : "Pechuga en Salsa con Tocineta",
        "667f06fe23caaaaf0451a641" : "Punta de Anca (Importada)",
        "5dbcb57ec557e50e67fec01f" : "Parrillada Mixta",
        "654ff6380779b105ec6ac20a" : "New York Steak",
        "654ff7ba33294a05ef9f32f7" : "Rib Eye Steak",
        "61a10ddf1fd14430485f8cb9" : "Picada de la Casa (Para 2)",
        "61a2657c1fd14430485f9f0e" : "Picada de la Casa (Para 4)",
        "6550028ec2087c73f3b7775e" : "Mini Burger x3",
        "61a118171fd14430485f8d78" : "Chicken Fingers",
        "619d6d801880235f6d5b1c36" : "Salmón Pepper Pink",
        "632df4983bcfe31bedde0e45" : "Pastas al Ajillo",
        "5dd9dc26b928d20df3b63e49" : "Pastas Alfred",
        "5e34ebb51ffca60e28d763ef" : "Camarones al Ajillo",
        "61a110b91880235f6d5b45a3" : "Arroz Samuelito",
        "5f9b5233ef1e265d296b0f8d" : "Arroz de Camarones",
        "6796793106b0703ef18a9f72" : "Club Sándwich",
        "61a119621880235f6d5b4644" : "Ensalada con Atún",
        "61a119421fd14430485f8d96" : "Ensalada con Pollo",
        "618b0decad2f690565ff0342" : "Sushi Samuelito Rolls",
        "67981a7ca9cfd2df9753864e" : "Burger la del Chef",
        "5f9b5636ef1e265d296b0fd3" : "Clasic Burger",
        "5dbcb612c557e50e67fec02b" : "Hamburguesa Felipa",
        "5dbcb645c557e50e67fec02e" : "Samuelito Burger",
        "67981bf757fc699d06fbe11c" : "Hot Dog Hawaiano",
        "5ef55e5619721c49eb8bb24a" : "Hot Dog Clásico",
        "5dbcb6a5c557e50e67fec03e" : "Hot Dog Suizo",
        "5dbcb67cc557e50e67fec031" : "Salchipupera",
        "5dc7332e7c14810dfd3fec34" : "Salchipapa Tradicional",
        "5f9b3922ef1e265d296b0d95" : "Desgranado de la Casa",
        "5dc7337b7c14810dfd3fec38" : "Desgranado Pupero",
        "6133f09d5af774183ce25e0f" : "Caja Barrilera",
        "6133e891d145504ca38cbeeb" : "Chicharrón al Barril",
        "6133f070d145504ca38cbf3a" : "Costillas BBQ al barril",
        "5dc099e151aceb0dd757c620" : "Frutos Amarillos",
        "5dbe24b354eef30e209928e8" : "Frutos Rojos",
        "5dc0a48751aceb0dd757c6fa" : "Limonada cerezada",
        "5dc0a48751aceb0dd757c6fb" : "Hierba Buena",
        "5dc0a48751aceb0dd757c6fc" : "Limonada de coco",
        "5dc0a60f51aceb0dd757c70f" : "Limonada Natural",
        "5e226a93641dd30e29531e11" : "Cuba Libre",
        "5dbcbb91c557e50e67fec108" : "Gin Tonic",
        "5dbcbb4ec557e50e67fec0ff" : "Piña Colada",
        "5f836639e5d38924870320a5" : "Vodka Citrux",
        "639c9ea052617c1b981ee5f4" : "Margarita Tradicional",
        "639c9e7352617c1b981ee5e1" : "Margarita de Fresa",
        "639c9e7352617c1b981ee5e4" : "Margarita de Corozo",
        "639c9e7352617c1b981ee5e2" : "Margarita Maracuyá",
        "653859e9dc0e3f05d9fd5ccd" : "Margarita de Lulo",
        "639c9ef852617c1b981ee604" : "Mojito Tradicional",
        "639c9ef852617c1b981ee605" : "Mojito de Fresa",
        "64a1d25d9c7cb205f4f48a23" : "Mojito de Kiwi",
        "639c9ef852617c1b981ee606" : "Mojito de Maracuyá",
        "5dc4ce4651aceb0dd757e786" : "Brownie con Helado",
        "639c9b7d3c1b5a05f0d8fb97" : "Malteada de Oreo",
        "5f9b455cef1e265d296b0eab" : "Panacota de Frutos Rojos",
        "639c9ba452617c1b981ee446" : "Malteada de Nutela",
        "65500860c2087c73f3b778a3" : "Malteada de Milo",
        "6133e235d145504ca38cbd7e" : "Malteada de Café",
        "65550a945e11f905f75326f5" : "Copa de helado GOURMET",
        "62b0b0e63996f328856ad5c3" : "Café EXPRESO",
        "62b0b10f3996f328856ad5c6" : "Café AMERICANO",
        "66f990de998c13da021a89ac" : "Café Balanceado",
        "62b0b16b3996f328856ad5d1" : "Café Capuchino"
      };
      const order = message.order;
      productos = order.product_items;

      // Calcula el total usando reduce
      precioTotal = productos.reduce((total, item) => total + (item.item_price * item.quantity),0);

      // 2. Renombra los productos usando el diccionario
      const productosNombres = productos.map(item => {
        const nombre = product_names[item.product_retailer_id] || item.product_retailer_id;
        return `${nombre} x${item.quantity}`;
      });

      // 3. Construye el string del pedido para mostrarlo bonito
      pedidoStr = productosNombres.join('\n');

      datosPedido['monto'] = precioTotal;
      // 4. Pasa el string de nombres a handleHiringFlow
      await messageHandler.handleHiringFlow(message.from, pedidoStr, datosPedido);
    }
    else {
      await messageHandler.handleIncomingMessage(message, senderInfo);
    }
    } catch (error) {
      console.error('Error procesando el mensaje:', error);
    }
  }

  async handleFlow(req, res) {
    if (!privateKey) {
      throw new Error(
        'Private key is empty. Please check your env variable "PRIVATE_KEY".'
      );
    }

    if(!isRequestSignatureValid(req)) {
      return res.status(432).send();
    }

    let decryptedRequest = null;
    try {
      decryptedRequest = decryptRequest(req.body, privateKey, config.PASSPHRASE);
    } catch (err) {
      console.error(err);
      if (err instanceof FlowEndpointException) {
        return res.status(err.statusCode).send();
      }
      return res.status(500).send();
    }

    
    const { aesKeyBuffer, initialVectorBuffer, decryptedBody } = decryptedRequest;
    let screenResponse;
    const numero = idNumber["numero"]
    if (decryptedBody.screen === 'DETAILS' || decryptedBody.screen === "SUMMARY") {
      screenResponse = await getNextScreen(decryptedBody, productos, datosPedido.monto, pedidoStr, numero);
    }
    if (decryptedBody.screen === 'RESERVA' || decryptedBody.screen === "RESUMEN") {
      screenResponse = await nextScreen(decryptedBody);
    } else if (decryptedBody.screen === 'RECOMMEND' || decryptedBody.screen === "RATE") {
      screenResponse = await nextEncuesta(decryptedBody);
    }
    // handle health check request
    if (decryptedBody.action === "ping") {
      screenResponse = await getNextScreen(decryptedBody);
    }
    ventana = decryptedBody.screen
    if (ventana === "RESUMEN") {
      datosReserva = decryptedBody.data
    } else if (ventana === "SUMMARY") {
      datosPedido["datos"] = decryptedBody.data
    }

    res.send(encryptResponse(screenResponse, aesKeyBuffer, initialVectorBuffer));
    
  };

  async handleEvent(req, res) {
    try {
      const numero = idNumber["numero"]
      const event = req.body;
      if (event && event.data && event.data.transaction) {
        await messageHandler.handleWompiEvent(event.data.transaction,numero);
      }
      res.status(200).send('Evento recibido');
    } catch (error) {
      console.error("Error procesando evento de Wompi:", error);
      res.status(500).send('Error procesando evento');
    }
  }

  verifyWebhook(req, res) {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === config.WEBHOOK_VERIFY_TOKEN) {
      res.status(200).send(challenge);
      console.log('Webhook verified successfully!');
    } else {
      res.sendStatus(403);
    }
  }
}

export default new WebhookController();