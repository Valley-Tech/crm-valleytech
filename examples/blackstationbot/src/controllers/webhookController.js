import config from '../config/env.js';
import { decryptRequest, encryptResponse, FlowEndpointException } from "../services/encryption.js";
import { getNextScreen } from "../services/flow.js";
import { nextEncuesta } from "../services/flowEncuesta.js";
import messageHandler from '../services/messageHandler.js';
import crypto from "crypto";
import { CRM_MODE, forwardWebhook, toMetaMessage } from '../services/crmAdapter.js';
import fs from 'fs'

// const privateKey = fs.readFileSync('private_key_pkcs8.pem', 'utf8'); // Para Local
const privateKey = config.PRIVATE_KEY; // Para Producción
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
        await messageHandler.handleIncomingMessage(message, senderInfo, ventana, datosPedido, pedidoStr);
      }
      else if (message?.type === 'order') {
      const product_names = {
        "69d5082a9bf0d32ae9a89dd9" : "7 Cereales x 60gr",
        "69d3b75e337ef3c0ce16b0ee": "Aceite Capilar de Aguacate x 50ml",
        "69d515d46b3269bbe4d22121": "Aceite Ideal x 182ml",
        "69d515be49248df9f89af34c": "Aceite Ideal x 380ml",
        "69d5159e337ef3c0ceb57793": "Aceite Laura x 900ml",
        "69d515396b3269bbe4d1468e": "Aceite Oleo Valle x 2700ml",
        "69d3b7735e7da3a2f60226d0": "Aceite de Bebe x 50ml",
        "69c218e91a3df39f11010adb": "Acetaminofén Jarabe x 60ml",
        "69c21386f055928f6ddab2eb": "Acetaminofén x 500mg",
        "69d3b54d6d06a3361b4d59b6": "Acondicionador Dove Restauración x 18ml",
        "69d3b2db5e7da3a2f6fda87b": "Acondicionador Nutribela 15 Reparación Intensiva x 15ml",
        "69d3b27549248df9f8033791": "Acondicionador Savital Con Aceite de Argan Y Sábila x 25ml",
        "69c2104f817aaac0ae5feb60": "Advil Max",
        "69d7abe5788108078f3bccc2": "Agua 6 Litros",
        "69d8f716e4843af3b4f20bb4": "Agua Cielo 1L",
        "69d8f8484dbce094f8ea6794": "Agua Coco x 400ml",
        "69d8f51642a93f3786ce4dad": "Agua Cristal 1L",
        "69d8f43a42a93f3786cda868": "Agua Cristal Con Gas x 300ml",
        "69d8f4224dbce094f8e6e87a": "Agua Cristal x 300ml",
        "69d8f4634dbce094f8e74bd7": "Agua Génesis x 600ml",
        "69c36847fd71b5f79f0423f2": "Ajo Revuelto",
        "69d68f7b2af86b6d19008ccb": "Ajonjolí x 100 Unidades",
        "69d68f5a8ca23c3471c1d245": "Ajonjolí x Unidad",
        "69c36b2420de4f254d316291": "Ají Picante x 100ml",
        "69c36b146a7528a70c1d8a3c": "Ají Picante x 165ml",
        "69c218ba7bff33f4a31fd7c5": "Alcohol 70% MK x 350ml",
        "69c217e1335b9ea55fece1cf": "Algodón x 20gr",
        "69c2134b7896dea20a6de140": "Alkasetser",
        "69c2150b7bff33f4a31e489a": "Alkasetser Xtreme",
        "69c226dbfd71b5f79f61d16b": "Almendra Natural x 150gr",
        "69c2146919d90721373bacdd": "Amoxicilina x 500mg",
        "69d8f409681205cd21d38f87": "Amper x 473ml",
        "69c2147b817aaac0ae621f7b": "Ampicilina x 500mg",
        "69c3677ffd71b5f79f040165": "Anís En Grano",
        "69c3676dbfb27e5db666fa9a": "Anís Estrellado",
        "69c21021fd71b5f79f5bc57a": "Apronax",
        "69d516051e65c66f59c2b41b": "Arepa Arepa x 500gr",
        "69d90dbef2b6880f9d976373": "Arequipe Alpina",
        "69d90d7ef600f1b5793a1334": "Arequipe Alpina x 220gr",
        "69d90d98f2b6880f9d9731d9": "Arequipe Alpina x 500gr",
        "69c3723e1b70fbcf1bc67a83": "Aromax x 10gr",
        "69d3c34649248df9f813421f": "Aromática Hindu Toronjil",
        "69d3c3295e7da3a2f60dfe7a": "Aromáticas Hindu Limoncillo",
        "69d51fb7337ef3c0cec20bf6": "Arroz Diana x 500gr",
        "69d54d2bd35d817d1e092cb4": "Arveja Con Zanahoria Zenu x 190gr",
        "69d54d17d35d817d1e08f69b": "Arveja Zenu x 190gr",
        "69c22250fd71b5f79f615912": "Arándanos Deshidratados x 150gr",
        "69c212f5b5b1d14e317dbf5e": "Aspirina 100",
        "69c21359b5b1d14e317df5f1": "Aspirina Efervescente",
        "69d51cb71e65c66f59ca4ae7": "Atún Lomitos En Aceite Ideal x 175gr",
        "69d51f7049248df9f8a75233": "Atún Lomitos Vam Camps x 160gr",
        "69d51f7f6b3269bbe4de4882": "Atún Lomitos Vam Camps x 80gr",
        "69d8febd4dbce094f8ef84cf": "Avena Alpina 1L",
        "69d9083cf600f1b57933e64c": "Avena Alpina Canela x 250gr",
        "69d908df2ec32e38346eea3e": "Avena Alpina Fitness x 250gr",
        "69d9082bdef710fb3c81f282": "Avena Alpina x 250gr",
        "69d8f9f6681205cd21d8bbaf": "Avena Codelac x 200ml",
        "69d8fa26b36510b69a645b18": "Avena Colanta x 1200ml",
        "69d51ff32440c8c597bc73cc": "Avena En Hojuelas x 200gr",
        "69d8f9dd531e7250784db28f": "Avena Klarens x 200ml",
        "69d52019337ef3c0cec2883c": "Avena Molida x 200gr",
        "69c374a2a88b9bc519bf3251": "Axion x 235gr",
        "69c3682675e6fcf877e21b7a": "Azúcar De Leche",
        "69d517536b3269bbe4d3c9ee": "Azúcar Incauca x 500gr",
        "69d51881deafcfb1d18d0b73": "Azúcar Riopalia x 500gr",
        "69d3b80f5e7da3a2f602b880": "Balance Clinical Men x 9gr",
        "69d3b82249248df9f807fe87": "Balance Clinical Women x 9gr",
        "69d3b8d75e7da3a2f603f359": "Balance Normal Duo",
        "69d8ff7d42a93f3786d6c182": "Bandeja Uva Combinada",
        "69d8ff93695e2ef9f7c05ffb": "Bandeja de Fresa",
        "69c372a37896dea20a094364": "Barra De Detergente Dersa x 250gr",
        "69d6689f2c4e357a8518c4df": "Barra de Cereal Tosh",
        "69d6889142a93f3786c577c1": "Bianchi Chocolate Blanco x 100 Unidades",
        "69d6882e8ca23c3471b0b1c9": "Bianchi Chocolate Blanco x Unidad",
        "69d688e4cced254ef4307f06": "Bianchi Chocolate x 100 Unidades",
        "69d688ce8dab334394e96682": "Bianchi Chocolate x Unidad",
        "69c36801a88b9bc519bbc966": "Bicarbonato",
        "69d90c3cf600f1b57938c286": "Bimbolete Bimbo",
        "69d7b1968dab3343945ac8d4": "Biocross x Sobre",
        "69d50f4749248df9f894a3e6": "Black And White x 700ml",
        "69d69383b1a817c41940c1a2": "Bocadillo Combinado x 12 Unidades",
        "69d69216bedddfd69ada4b40": "Bocadillo Combinado x Unidad",
        "69d690ed42a93f3786d8f736": "Bocadillo Hojita x Unidad",
        "69d693a92af86b6d190810b6": "Bocadillo x 150gr",
        "69d50c951e65c66f59ba2702": "Bolsa 10 Kilos x Unidad",
        "69d50cd9deafcfb1d180b2e3": "Bolsa 2 kilos x unidad",
        "69d50d172440c8c597a86e99": "Bolsa 20 Kilos x Unidad",
        "69d677378ca23c3471951fac": "Bolsa Boli Pequeño",
        "69d677632c4e357a852bcf5f": "Bolsa De Basura Extra Jumbo x Unidad",
        "69d6774bcced254ef40ff5a8": "Bolsa De Papel #2",
        "69d676fd8dab334394ca6f98": "Bolsa Hielo Grande Azul",
        "69d6770cbedddfd69aa67dff": "Bolsa Hielo Pequeña Azul",
        "69d7aba3dde5ad53159e73d7": "Bolsa de Agua x 300ml",
        "69d6777b8dab334394cb2ec0": "Bolsa de Basura Extra Jumbo x Paquete x 10",
        "69d689605f0010c7d1ee7582": "Bom Bom Bum Original",
        "69d6896d8ca23c3471b2a72c": "Bom Bom Bum Pin Pop",
        "69d90a62af2108383d22394c": "Bon Yurt Zucaritas",
        "69c212467bff33f4a31d16ef": "Bonfiest",
        "69d7c00a42a93f37863d02b2": "Bretaña x 300ml",
        "69c376d920de4f254d32fb19": "Brillo Chino",
        "69c376ce1b70fbcf1bc6f723": "Brillo Fino",
        "69d90bfe7da5b1ef28b1fb68": "Brownie",
        "69d7ab6305edc105d452b1f2": "Budweiser x 269ml",
        "69d9062e681205cd21e472e1": "BurbuJet",
        "69c211a7b5b1d14e317d0743": "Buscapina Compuesta",
        "69c2129efd71b5f79f5d45eb": "Buscapina Fem",
        "69d54fc5c7687b049a9ab2a3": "Café Juan Valdez Avellana x 50gr",
        "69d51489d35d817d1e9d375b": "Café Juan Valdez Clásico x 40gr",
        "69d52151d35d817d1eadacb0": "Café Juan Valdez Clásico x 8gr",
        "69d521c46e4f7183de98964f": "Café Juan Valdez Vainilla y Canela x 8gr",
        "69d54debc7687b049a962f65": "Café Juan Valdez Vanicanela x 50 gr",
        "69d66ae82af86b6d19bdb6d0": "Café Juan Valdez x 1.5gr",
        "69d66c31bedddfd69a983531": "Café Sello Rojo x 110gr",
        "69d66c4e8ca23c347187357b": "Café Sello Rojo x 212gr",
        "69d51bd0c7687b049a355544": "Café Sello Rojo x 40gr",
        "69d66c848dab334394bd56ef": "Café Sello Rojo x 425gr",
        "69d3c3a5524001f94ed19b3b": "Café Tostao x 40gr",
        "69c368a07896dea20a07269e": "Canela",
        "69c36812bfb27e5db6671111": "Canela En Polvo",
        "69d66b9d2af86b6d19be9c3a": "Capuccino Vainilla x 18gr",
        "69d90c6f7da5b1ef28b2be2e": "Casero Vainilla Bimbo",
        "69c4bcb67362d1fe0b8b6221": "Cepillo Colgate Medio",
        "69d3bac4337ef3c0ce19aabe": "Cepillo Dental Niño (a)",
        "69c4bca3cfdc708e20239bfe": "Cepillo Dental Platino Medio",
        "69d54dbd9bf0d32ae9206c90": "Champiñones Zenu x 150gr",
        "69c226571a3df39f1103359e": "Cheetos Boliqueso x 34gr",
        "69c223cf1a3df39f1102f5d7": "Cheetos Natural x 40gr",
        "69c223e2335b9ea55fef2c33": "Cheetos Picantes x 34gr",
        "69d7a6e9788108078f3727e8": "Chelitas",
        "69c2283df055928f6dde88c4": "Chicharrón BBQ x 50gr",
        "69c228677896dea20a71f4b8": "Chicharrón Limón x 50gr",
        "69c228241a3df39f110363d3": "Chicharrón Natural x 50gr",
        "69c2284e1a3df39f11036503": "Chicharrón Picante x 50gr",
        "69c227bc7bff33f4a3232df4": "Choco Krispis x 30gr",
        "69d90b9df600f1b57937fecf": "Chocolate Corona x 100gr",
        "69d90be065d4204c37004155": "Chocolate Corona x 200gr",
        "69d90b51def710fb3c858ed7": "Chocolate Corona x 450gr",
        "69d90b6cf2b6880f9d9527ca": "Chocolate Ideal x 250gr",
        "69d90b8365d4204c37ffd00a": "Chocolate Ideal x 500gr",
        "69d9060a695e2ef9f7c76831": "Chocolatina BurbuJet Crujivainilla x 50gr",
        "69d90669b36510b69a6fa1a8": "Chocolatina Jet Cookies and Cream x 50gr",
        "69d904ae531e72507856fca8": "Chocolatina Jet x 11gr",
        "69d9070bb0fb5071dcac759a": "Chocolatina Jumbo Edición Limitada Mimos x 170gr",
        "69d906bee4843af3b4ff5d2b": "Chocolatina Jumbo Edición Limitada Mimos x 90gr",
        "69d904d6695e2ef9f7c5c6a2": "Chocolatina Jumbo Maní x 17gr",
        "69d90544b0fb5071dcaa21b9": "Chocolatina Jumbo Maní x 35gr",
        "69d90558531e72507857e11c": "Chocolatina Jumbo Maní x 90gr",
        "69d906f542a93f3786de84c5": "Chocolatina Montblanc x 60gr",
        "69d90c2d7da5b1ef28b22abd": "Chocoso Bimbo",
        "69d9139f69b309cf44adc8b4": "Chorizo Campesino Colanta x 2",
        "69d912def2b6880f9d9d4771": "Chorizo Ternera Zenu x 2",
        "69d913703393eb999423cfc9": "Chorizo Ternera Zenu x 8",
        "69d50ed66e4f7183de842050": "Cinta Ancha x 50 Yardas",
        "69c367f07896dea20a0714a5": "Clavito",
        "69d7dc3e42a93f378669a0b2": "Coca Cola 1.5L",
        "69d7dc3142a93f3786697f27": "Coca Cola 1L",
        "69d7dc4b05edc105d4932f51": "Coca Cola 2.5L",
        "69d7c07e05edc105d4689411": "Coca Cola x 400ml",
        "69d686bb8ca23c3471add12a": "Coffee The Light x 100 Unidades",
        "69d686a38dab334394e4e803": "Coffee The Light x Unidad",
        "69d7b006556e9821476a9f1c": "Cognos x Sobre",
        "69d66bea8ca23c347186d446": "Colcafe Caramelo x 50gr",
        "69d66c022c4e357a851cb95f": "Colcafe Vainilla x 50gr",
        "69d66b45125e0f80537bfe1d": "Colcafe x 1.5 gr",
        "69c4b5f31b70fbcf1b6db8cd": "Colgate Doble Frescura x 60ml",
        "69c4b86d1b70fbcf1b6eca0f": "Colgate Triple Acción x 22ml",
        "69c4b808cfdc708e20219966": "Colgate Triple Acción x 75ml",
        "69c4b7b5309b847b30a2d4b8": "Colgate x 60ml",
        "69d8f69e58479361019907df": "Colombiana Postobon 1.5L",
        "69c36c7c6a7528a70c1df41d": "Completísimo Desmenuzado",
        "69d909bc3393eb999419af14": "Compota de Manzana",
        "69d909c965d4204c37fdd6a0": "Compota de Pera",
        "69d3bb122440c8c59722a650": "Condones Duo",
        "69d3bae7524001f94ec8bc59": "Condones Tulip",
        "69d3b6956b3269bbe44250f9": "Copitos",
        "69d7aa0595734f580fdeeffe": "Corona x 330ml",
        "69d3ba9a6b3269bbe4466255": "Corta Uñas",
        "69d7aabf788108078f3aaee1": "Costeña Bacana x 269ml",
        "69d90adab200cc804d99d6b6": "Crema De Leche Alqueria x 400gr",
        "69d90b2c2ec32e38347174ed": "Crema De Leche Alqueria x 850gr",
        "69d3b86d719c4da024d3fbcd": "Crema Forz x 12gr",
        "69d3b25c5e7da3a2f6fd5b54": "Crema Para Peinar Savital Con Aceite de Argan Y Sábila x 25ml",
        "69d3b8b82440c8c59720a64a": "Crema Ponds Rejuveness x 8.5gr",
        "69d50844d35d817d1e901ec3": "Crema arroz x 60gr",
        "69d90b1969b309cf44a39ac0": "Crema de Leche Alqueria x 125gr",
        "69d677d0cced254ef4109640": "Cuchara x 100 Unidades",
        "69d677fd2c4e357a852c7ed8": "Cuchillo x 100 Unidades",
        "69c2152bb5b1d14e317ea6b1": "Curitas",
        "69c2233c7bff33f4a32253bd": "De Todito BBQ Mega",
        "69c228a81a3df39f1103714a": "De Todito BBQ x 165gr",
        "69c222bf19d90721373eeb73": "De Todito BBQ x 50gr",
        "69c222f17bff33f4a3224ce7": "De Todito Flamit Hot x 50gr",
        "69c228bc7896dea20a71fafe": "De Todito Limón x 165gr",
        "69c22273b5b1d14e31819fff": "De Todito Limón x 50gr",
        "69c22327335b9ea55fef1534": "De Todito Mix Mega",
        "69c22898f055928f6dde8aed": "De Todito Mix x 165gr",
        "69c222da335b9ea55fef097d": "De Todito Mix x 50gr",
        "69c22310fd71b5f79f61659e": "De Todito Natural Mega",
        "69c22886335b9ea55ff03046": "De Todito Natural x 165gr",
        "69c222889d3d40869967bb05": "De Todito Natural x 50gr",
        "69c213199d3d40869963b864": "Descongel Gripa",
        "69c36fd8872399ad64754151": "Detergente Dersa Floral x 1000gr",
        "69c36e617896dea20a088c7e": "Detergente Dersa Floral x 125gr",
        "69c36e7a6a7528a70c1e9c10": "Detergente Dersa Floral x 250gr",
        "69c36e5075e6fcf877e38f55": "Detergente Dersa Manzana x 125gr",
        "69c21443817aaac0ae61faef": "Diclofenaco x 100mg",
        "69c228d7fd71b5f79f62036b": "Doritos x 185gr",
        "69c226bc7bff33f4a32302cd": "Doritos x 43gr",
        "69c36c4c872399ad64747ae6": "Doña Gallina Cubo",
        "69c36c591b70fbcf1bc535dc": "Doña Gallina Desmenuzado",
        "69d69017cced254ef4447d84": "Dulce Platanito x 100 Unidades",
        "69d6900742a93f3786d739c8": "Dulce Platanito x Unidad",
        "69c212cef055928f6dda5831": "Duraflex Muscular Advance",
        "69d7aef6788108078f3f6b2f": "Ego",
        "69d7afb94dbce094f848f152": "Ego Life x Sobre",
        "69d7c025dde5ad5315b2ea90": "Electrolit Maracuyá x 625ml",
        "69d3c2f36b3269bbe44ec2fc": "Esencia De Coco x500ml",
        "69d3c302337ef3c0ce225f56": "Esencia de Kola x 500ml",
        "69c376a1872399ad64761319": "Esponja Oro Plata",
        "69c376bebfb27e5db6699d7e" : "Esponja Verde y Amarillo",
        "69c3716ebfb27e5db669239f" : "Exterminador En Aceite x 240ml",
        "69c3718afd71b5f79f0696fe" : "Exterminador Liquido x 500ml",
        "69c36efb872399ad64751bfc" : "Fabulav Citronela x 1000ml",
        "69c374766a7528a70c1f5dba" : "Fabuloso Floral x 180ml",
        "69c374663cce32fbe56dcee0" : "Fabuloso Lavanda x 180ml",
        "69c373a4a88b9bc519bf23c1" : "Fama Bebe x 250gr",
        "69c373896a7528a70c1f313f" : "Fama Total x 250gr",
        "69d3c1d05e7da3a2f60d01fd" : "Fecula de Maiz",
        "69d7b17fdde5ad5315a54e60" : "Fem Plus x Sobre",
        "69d7afa7788108078f407223" : "Fibern Plus x Sobre",
        "69c376f73cce32fbe56e2443" : "Fibra Clasica",
        "69d66a75125e0f80537b3814" : "Fideo Comarrico x 120gr",
        "69d66a8842a93f3786982901" : "Fideo Comarrico x 454gr",
        "69d687e08ca23c3471b027e6" : "Fruticas de Corazón x 100 Unidades",
        "69d68753bedddfd69ac17766" : "Fruticas de Corazón x Unidad",
        "69d3c0854cb3c588620feb86" : "Frutiño Durazno",
        "69d3c03449248df9f80fca9b" : "Frutiño Frutos Rojos",
        "69d3c109719c4da024db4995" : "Frutiño Guanábana",
        "69d3be276d06a3361b55decb" : "Frutiño Limonada",
        "69d3c1454cb3c588621092ec" : "Frutiño Mango",
        "69d3c0b96b3269bbe44caf05" : "Frutiño Maracumango",
        "69d3be4f4cb3c588620d5485" : "Frutiño Maracupiña",
        "69d3be3d719c4da024d90f26" : "Frutiño Maracuyá",
        "69d3c0d8337ef3c0ce207988" : "Frutiño Naranja",
        "69d3c1585e7da3a2f60c85e9" : "Frutiño Piña",
        "69d3be956b3269bbe44aeca2" : "Frutiño Salpicón",
        "69d3c16f49248df9f810d687" : "Frutiño Salpicón Amarillo",
        "69d3c06e6b3269bbe44c7d76" : "Frutiño Tamarindo",
        "69c36ec83cce32fbe56d16c3" : "Fábulav Citronela x 500ml",
        "69c36f11bfb27e5db6689e3b" : "Fábulav Floral x 1000ml",
        "69c36edffd71b5f79f061959" : "Fábulav Floral x 500ml",
        "69c36f221b70fbcf1bc5c85b" : "Fábulav Limón x 1000ml",
        "69d3c2c9719c4da024dc9dd0" : "Fósforos El Sol",
        "69d66990125e0f80537a9f0a" : "Galleta Cocosette",
        "69d66a1f2af86b6d19bca290" : "Galleta Ducales x 1 Taco",
        "69d6699f8dab334394b98a43" : "Galleta Dux",
        "69d6691842a93f378696ccbf" : "Galleta Festival Chocolate x6",
        "69d668d0b1a817c419f484db" : "Galleta Festival Fresa x6",
        "69d668e62c4e357a85191686" : "Galleta Festival Limón x6",
        "69d66931125e0f80537a5bec" : "Galleta Festival Recreo x6",
        "69d668f9b1a817c419f4ab2f" : "Galleta Festival Vainilla x6",
        "69d6696742a93f378696ffb5" : "Galleta Oreo x14",
        "69d66a09125e0f80537ae998" : "Galleta Saltin Noel x 1 Taco",
        "69d669d1cced254ef4fcad57" : "Galleta Tosh 4 Cereales",
        "69d669c242a93f3786976d87" : "Galleta Tosh Ajonjolí",
        "69d669b38ca23c34718422df" : "Galleta Tosh Miel",
        "69d7a634dde5ad5315998eaf" : "Galleta de Queso",
        "69c215b0fd71b5f79f5eb610" : "Gastrofast",
        "69d8f34bb0fb5071dc9991f5" : "Gatorade x 500ml",
        "69d7aec04dbce094f8484472" : "Gatorlite Fresa Kiwi x 620ml",
        "69d7ae70dde5ad5315a0fcf2" : "Gatorlite Moras x 620ml",
        "69d7ae997a48182babee925f" : "Gatorlite Uva x 620ml",
        "69c2155a7bff33f4a31e5b16" : "Gaviscon Doble Acción",
        "69d3b5e3524001f94ec45c0c" : "Gel Ego Attraction x 15ml",
        "69d8faeeb36510b69a6511fa" : "Gelatina Boggy Fresa",
        "69d8fb01e4843af3b4f4c89c" : "Gelatina Boggy Mora",
        "69d8fb5ab36510b69a657b6d" : "Gelatina Boggy Naranja",
        "69d508a12440c8c597a39a62" : "Gelatina Frambuesa Frutiño",
        "69d508b8d35d817d1e9078a2" : "Gelatina Fresa Sandía Frutiño",
        "69d8fa844dbce094f8ec9cbe" : "Gelatina Klarens Fresa",
        "69d8fa9542a93f3786d28315" : "Gelatina Klarens Mora",
        "69d8fab1376bb5d93eae95db" : "Gelatina Klarens Naranja",
        "69d508782440c8c597a38a79" : "Gelatina Limonada Frutiño",
        "69d50888d35d817d1e9052ab" : "Gelatina Mandarina Frutiño",
        "69d509486b3269bbe4c55cce" : "Gelatina Piña Frutiño",
        "69d508611e65c66f59b52f2a" : "Gelatina Sin Sabor Frutiño",
        "69d68ef98dab334394f962f8" : "Gengibre x 50 Unidades",
        "69d68ee5125e0f8053baedb5" : "Gengibre x Unidad",
        "69c4bd04fd71b5f79fb1f51d" : "Gillette Venus Suave 3 Hojas",
        "69c3703c6a7528a70c1ec3f4" : "Glade Campos de Lavanda x 400ml",
        "69c370c93cce32fbe56d5292" : "Glade Paraíso Azul x 400ml",
        "69d66a43bedddfd69a95c044" : "Gol",
        "69c21d5e7896dea20a70a2e9" : "Golpe Con Todo BBQ x 45gr",
        "69c21a527896dea20a701c05" : "Golpe Con Todo Limón x 140gr",
        "69c21d841a3df39f110203a4" : "Golpe Con Todo Limón x 45gr",
        "69c21da2fd71b5f79f609c2e" : "Golpe Con Todo Mayonesa x 140gr",
        "69c21d481a3df39f1101fd6e" : "Golpe Con Todo Mayonesa x 45gr",
        "69c21d367896dea20a709b9b" : "Golpe Con Todo Natural x 45gr",
        "69c21a36817aaac0ae64710f" : "Golpe Con Todo Ranchero x 250gr",
        "69c22941f055928f6dde94a6" : "Gomita Trululu Sabores x 70gr",
        "69c2292d335b9ea55ff03f29" : "Gomita Trululu Splash x 70gr",
        "69c229861a3df39f1103940a" : "Gomitas Trululu Aros x 70gr",
        "69c22974f055928f6ddeaf79" : "Gomitas Trululu Feroz x 70gr",
        "69c229c17bff33f4a3236ae3" : "Gomitas Trululu Fresitas x 70gr",
        "69c229591a3df39f11038692" : "Gomitas Trululu Gusanos x 70gr",
        "69c2299a7896dea20a720b75" : "Gomitas Trululu Lenguas x 70gr",
        "69c229aefd71b5f79f6223dc" : "Gomitas Trululu Oro x 70gr",
        "69c3767efd71b5f79f071be2" : "Guante Doméstico Talla M",
        "69d8f48d681205cd21d4526c" : "H2O Limonata x 600ml",
        "69d68b7abedddfd69acb6b68" : "Halls Limón Y Miel Barra",
        "69d68bc9cced254ef439f4d7" : "Halls Mentol Y Cereza Barra",
        "69d68add2c4e357a854d62e2" : "Halls Mentol Y Eucalipto Barra",
        "69d68a27125e0f8053ae7179" : "Halls Mentol Y Eucalipto Extra Fuerte Barra",
        "69d68ba88dab334394f20308" : "Halls Yerbabuena Barra",
        "69d516279bf0d32ae9b7a3fa" : "Harina Pan x 1000gr",
        "69d51fdbc7687b049a3b0655" : "Harina Pan x 500gr",
        "69d51fca49248df9f8a7a541" : "Harina de Trigo Robin Hood x 500gr",
        "69d7b01742a93f37862c5a6f" : "Homo Plus x Sobre",
        "69d68fe9b1a817c419383c1d" : "Huevitos de Almendra x 100 Unidades",
        "69d68fd4bedddfd69ad5bdb5" : "Huevitos de Almendra x Unidad",
        "69d91b3cf600f1b5794b8131" : "Huevos x 30 Unidades",
        "69d91b257da5b1ef28c3f3b7" : "Huevos x Unidad",
        "69c2103d7896dea20a6c422c" : "Ibuflash Migraña",
        "69c2142019d90721373b83f2" : "Ibuprofeno x 800mg",
        "69c3726620de4f254d329f66" : "Insecticida Katori x 25gr",
        "69d90f0fb200cc804d9de1a6" : "Jamón Cunit x 230gr",
        "69c2160a19d90721373c246e" : "Jeringa x 5ml",
        "69d7a81d42a93f3786240def" : "Jhonny Wallker Red Label",
        "69c4bc4acfdc708e20238321" : "Jabón Johnson's Almendras Y Avena x 110gr",
        "69c4bc79e61fb4357fc3b5d1" : "Jabón Johnson's Aloe Y Vitamina E x 110gr",
        "69c4bb101b70fbcf1b6fd2eb" : "Jabón Johnson's Rosas Y Sándalo x 110gr",
        "69c4bb2e7362d1fe0b8acef8" : "Jabón Johnson's x 110gr",
        "69d7d9fa8dab33439493075e" : "Jugo Del Valle Naranja 1.5L",
        "69d7c09f788108078f540a43" : "Jugo Del Valle Naranja x 400ml",
        "69d8f5ec695e2ef9f7b7009f" : "Jugo Hit Mango 1L",
        "69d8f254b0fb5071dc990c2f" : "Jugo Hit Mango x 200ml",
        "69d8f303584793610195e4bf" : "Jugo Hit Mango x 500ml",
        "69d8f59f695e2ef9f7b6bd98" : "Jugo Hit Mora 1L",
        "69d8f26942a93f3786cc0340" : "Jugo Hit Mora x 200 ml",
        "69d8f2a0681205cd21d2565d" : "Jugo Hit Mora x 500ml",
        "69d8f56f42a93f3786cebf3c" : "Jugo Hit Naranja Piña 1L",
        "69d8f242681205cd21d218e3" : "Jugo Hit Naranja Piña x 200ml",
        "69d8f2dc681205cd21d29b03" : "Jugo Hit Naranja Piña x 500ml",
        "69d8f58c695e2ef9f7b6bca9" : "Jugo Hit Tropical 1L",
        "69d8f2794dbce094f8e5ae37" : "Jugo Hit Tropical x 200ml",
        "69d8f2b3e4843af3b4ef64a2" : "Jugo Hit Tropical x 500ml",
        "69d90782def710fb3c811b1c" : "Jugo Nativa manzana x 200ml",
        "69d907a0b200cc804d95c1f2" : "Jugo Nutiva Mango x 200ml",
        "69d907b17da5b1ef28ac78d2" : "Jugo Nutiva Mora x 200ml",
        "69d907723393eb99941742f5" : "Jugo nutiva Pera x 200ml",
        "69d9073f695e2ef9f7c8928c" : "Jumbo Flow Chocolate Blanco x 48gr",
        "69d9074f376bb5d93ebb1113" : "Jumbo Flow Chocolate Negro x 48gr",
        "69c215d5b5b1d14e317ede7d" : "Kola Granulada MK",
        "69d7c0e54dbce094f85b9dc2" : "Kola Román 1.5L",
        "69d7c040431c7881507665a5" : "Kola Román x 400ml",
        "69d908eeb200cc804d975c74" : "Kumis x 200ml",
        "69c2272d335b9ea55ff00c70" : "La Especial Mix Arándanos x 180gr",
        "69c227447bff33f4a3232346" : "La Especial Mix Nueces x 180gr",
        "69c22759fd71b5f79f61eb82" : "La Especial Mix Pasas x 180gr",
        "69c2277ab5b1d14e3182ae9e" : "La Especial Mix Sal x 180gr",
        "69d3b7b6deafcfb1d1e898e8" : "Lady Speed Stick Clinical x 30gr",
        "69d3ba33524001f94ec83be9" : "Lady Speed Stick Clinical x 9gr",
        "69d3b8f7524001f94ec77112" : "Lady Speed Stick Duo x 30gr",
        "69d3b7a04cb3c58862080ed8" : "Lady Speed Stick x30gr",
        "69d91b9bdef710fb3c98d280" : "Lapicero Azul Bic x Unidad",
        "69d91b843393eb99942cf57b" : "Lapicero Negro Bic x Unidad",
        "69d91bdc7da5b1ef28c4ba4a" : "Lapicero Rojo Bic x Unidad",
        "69d8fcaa4dbce094f8ee2454" : "Leche Deslactosada Alpina 1L",
        "69d5105a1e65c66f59bdd358" : "Leche En Polvo San Diego x 380gr",
        "69d5198d49248df9f89f4016" : "Leche Klarens Deslactosada x 400ml",
        "69d5196c337ef3c0ceb9b31f" : "Leche Klarens Deslactosada x 900ml",
        "69d519269bf0d32ae9bac1cb" : "Leche Klarens x 400ml",
        "69d51912deafcfb1d18dc905" : "Leche Klarens x 900ml",
        "69d522332440c8c597be946a" : "Leche Klim x 25gr",
        "69d7aa52431c7881505f151f" : "Like Limón x 300ml",
        "69d7aa767a48182babea9b8d" : "Like Mango x 300ml",
        "69d7aa8c42a93f378626a624" : "Like Manzana x 300ml",
        "69d7aaad4dbce094f8443462" : "Like Mora Azul x 300ml",
        "69c375551b70fbcf1bc6de23" : "Limpido x 2000ml",
        "69c37540872399ad6475fb58" : "Limpido x 460ml",
        "69d90a85af2108383d22ab9b" : "Limón x 12 Unidades",
        "69d90a75f2b6880f9d93c142" : "Limón x Unidad",
        "69d3ba02524001f94ec82743" : "Lisso Inteligente x 15ml",
        "69c2136c335b9ea55feb5687" : "Loratadina x 10mg",
        "69c2139c1a3df39f11ff88f1" : "Lumbal Forte",
        "69c36c6f3cce32fbe56caa6c" : "Maggie Ricontodo Desmenuzado",
        "69d68dd8b1a817c419332d5f" : "Mamut Chocolate Blanco",
        "69d8f60db0fb5071dc9c7a90" : "Manzana Postobon 1.5L",
        "69d8f4d1b36510b69a601371" : "Manzana Postobon x 400ml",
        "69d8feea681205cd21dd39f2" : "Manzana Roja",
        "69d8ff0442a93f3786d66d24" : "Manzana Verde",
        "69c368367896dea20a071cd7" : "Manzanilla",
        "69c214907bff33f4a31e2a0c" : "Mareol",
        "69d900755847936101a0b948" : "Margarina Rama x 125gr",
        "69d90139376bb5d93eb4f576" : "Margarina Rama x 250gr",
        "69d8ffc8e4843af3b4f8896b" : "Margarina Rama x 50gr",
        "69c2212a9d3d408699676377" : "Margarita Limón x 36gr",
        "69c220e8b5b1d14e31816ce2" : "Margarita Mayonesa x 35gr",
        "69c22138817aaac0ae65a6e3" : "Margarita Pollo x 36gr",
        "69c370f66a7528a70c1ed222" : "Maxilin Limón x 450gr",
        "69c3661cbfb27e5db666ad95" : "Mayonesa Bary x 150gr",
        "69c369da3cce32fbe56bf103" : "Mayonesa Bary x 400gr",
        "69d5225d49248df9f8aa6d66" : "Maíz Pira x 250gr",
        "69d686f9cced254ef42d1e3d" : "Menta Helada x 100 Unidades",
        "69d686e242a93f3786c1a735" : "Menta Helada x Unidad",
        "69c214069d3d408699643684" : "Metronidazol x 500mg",
        "69c21543335b9ea55febfce1" : "Mieltertos",
        "69d50cafd35d817d1e94e831" : "Millar Bolsa 10 Kilos",
        "69d50dcb337ef3c0cead1612" : "Millar De Bolsa 20 Kilos",
        "69d50cf5337ef3c0ceac84c8" : "Millar de Bolsa 2 Kilos",
        "69d521e7c7687b049a3d4a55" : "Milo x 20gr",
        "69d7a54b95734f580fdab370" : "Mogolla Con Bocadillo",
        "69d7a55a7a48182babe56ee0" : "Mogolla Integral",
        "69d90621531e72507858e3bb" : "Montblanc Estuche x 3",
        "69d90efd69b309cf44a7b8cb" : "Mortadela Zenu x 250gr",
        "69c3698cfd71b5f79f0473f8" : "Mostaza",
        "69c36adc7896dea20a07a0f2" : "Mostaza San Jorge x 8ml",
        "69c366e63cce32fbe56b2d46" : "Mostaza x 140gr",
        "69c21122fd71b5f79f5c5747" : "Movidol",
        "69c213d47896dea20a6e041f" : "Naproxeno x 500mg",
        "69d8f78f4dbce094f8ea2444" : "Nectar California Manzana x 1200ml",
        "69d8f776b0fb5071dc9dc6fa" : "Nectar California Manzana x 900ml",
        "69d8f7da695e2ef9f7b915ab" : "Nectar California Manzana x 900ml",
        "69d8f7c3681205cd21d6cf62" : "Nectar California Pera x 1200ml",
        "69d8f75a695e2ef9f7b87705" : "Nectar California Pera x 900ml",
        "69d8f7edb0fb5071dc9e40f1" : "Nectar California Pera x 900ml",
        "69d66b2d8dab334394bb9e83" : "Nescafé x 1.5gr",
        "69d5119b9bf0d32ae9b31493" : "Nescafé x 150gr",
        "69c213341a3df39f11ff6603" : "Next Gel",
        "69c2116a19d90721373a4a40" : "Noraver Día",
        "69c211401a3df39f11fe31df" : "Noraver Fast Total",
        "69c2118c7bff33f4a31c8411" : "Noraver Garganta",
        "69c2115219d90721373a4231" : "Noraver Noche",
        "69c4be17e61fb4357fc43b4b" : "Nosotras Buenas Noches",
        "69c4bdeba88b9bc5196aaa7e" : "Nosotras Buenas Noches x 24 Unidades",
        "69c4be081b70fbcf1b7095e5" : "Nosotras Buenas Noches x 4 Unidades",
        "69c4be81e61fb4357fc449e5" : "Nosotras Normal x 10 Unidades",
        "69c4be67126013bf1f5ab65f" : "Nosotras Rapigel",
        "69c4be52fd71b5f79fb2575a" : "Nosotras Rapigel x 10 Unidades",
        "69c4be3ecfdc708e20244625" : "Nosotras Rapigel x 30 Unidades",
        "69c212de1a3df39f11ff4702" : "Noxpirin",
        "69d7afcd8dab33439457994c" : "Omniplus x Sobre",
        "69d7aff495734f580fe418ff" : "One C Mix x Sobre",
        "69d7abc08dab33439452cceb" : "Paca de Bolsa De Agua Caliente",
        "69d7abcd05edc105d452e2bc" : "Paca de Bolsa De Agua Fria",
        "69d68e002af86b6d19fd009f" : "Paleta Chilindrina",
        "69d3c2db337ef3c0ce222874" : "Palillos El Sol",
        "69c4b8f106882b0566572f95" : "Palmolive Avena x 75gr",
        "69c4ba6e7362d1fe0b8a9408" : "Palmolive Frescura Purificante x 110gr",
        "69c4b9b91dcfb49c18acc596" : "Palmolive Renovación Intensa x 110gr",
        "69c226a1335b9ea55feff903" : "Palomitas Caramelo x 68gr",
        "69d7a6a6dde5ad531599cc65" : "Pan Aliñado",
        "69d7a72095734f580fdc70e3" : "Pan Aliñado",
        "69d7a619788108078f366a2e" : "Pan Aliñado",
        "69d7a7058dab3343944dff95" : "Pan Caiman",
        "69d7a51e4dbce094f83f186e" : "Pan De Queso",
        "69d90cafb200cc804d9bc648" : "Pan Hamburguesa Bimbo",
        "69d7a6f84dbce094f8408770" : "Pan Mojarra",
        "69d90c9daf2108383d24d4e3" : "Pan Perro Bimbo",
        "69d7a737dde5ad53159a272d" : "Pan Piñita",
        "69d90c8cb200cc804d9b6e8b" : "Pan Tajado Bimbo",
        "69d7a65d05edc105d44e4923" : "Pan Tajado Servipan",
        "69d7a642556e98214761ae63" : "Pan Tostao",
        "69d7a72c7a48182babe7e790" : "Pan Uva",
        "69d7a52bdde5ad5315989943" : "Pan de Queso",
        "69d7a5398dab3343944be118" : "Pan de Queso",
        "69d3c1a22440c8c59729a6de" : "Panelada",
        "69d68e242af86b6d19fd552e" : "Panelitas x 100 Unidades",
        "69d68e115f0010c7d1f9af40" : "Panelitas x Unidad",
        "69c21519fd71b5f79f5e6b4a" : "Pangetan",
        "69d90c203393eb99941c8f7a" : "Panqué Bimbo",
        "69d3bbf86b3269bbe44811f2" : "Papel Higiénico Familia Megarrollo",
        "69d3bc615e7da3a2f6073e2c" : "Pañales Etapa 2 Huggies",
        "69d3bc73524001f94eca0054" : "Pañales Etapa 3 Huggies",
        "69d3bc9a5e7da3a2f607a8be" : "Pañales Etapa 4 Huggies",
        "69d3bcbbdeafcfb1d1ed53eb" : "Pañales Etapa 5 Huggies",
        "69d3ba66deafcfb1d1ea89a9" : "Pañitos Húmedos Pequeñín x24",
        "69d3ba836b3269bbe4465231" : "Pañitos Húmedos Pequeñín x80",
        "69d8f6b8681205cd21d60138" : "Pepsi 2.5L",
        "69d8f4b9e4843af3b4f0be88" : "Pepsi x 400ml",
        "69d8ff1858479361019fd609" : "Pera",
        "69d689d82af86b6d19fd009f" : "Piazza x 24 Unidades",
        "69d689c0b1a817c41928605d" : "Piazza x Unidad",
        "69c36793872399ad64732db2" : "Pimienta De Olor",
        "69c36c23bfb27e5db667eadb" : "Pimienta x 1gr",
        "69c36c32fd71b5f79f05681c" : "Pimienta x 50 sobres",
        "69c226fbf055928f6dde602b" : "Pistachos x 70gr",
        "69d678638dab334394cc241e" : "Pitillo",
        "69c229007896dea20a71ff28" : "Platanitos Caseros",
        "69d674d52c4e357a8528f30c" : "Plato Hondo Darnel #25",
        "69d67529b1a817c4190456a6" : "Plato Llano Darnel #18",
        "69d674b22c4e357a852863d6" : "Plato Llano Darnel #23",
        "69d7ab92dde5ad53159e681e" : "Pony Malta 1.5L",
        "69d7ab7a7a48182babeb72c0" : "Pony Malta 1L",
        "69d7aaf042a93f3786274006" : "Pony Malta Lata x 330ml",
        "69d7a79b05edc105d44f323f" : "Pony Malta x 200ml",
        "69d7a7b2788108078f379589" : "Pony Malta x 330ml",
        "69d7a78e8dab3343944e3d26" : "Pony Malta x 330ml",
        "69c21ec7fd71b5f79f60e11d" : "Popetas Caramelo x 165gr",
        "69c21a8c1a3df39f110186d9" : "Popetas Caramelo x 44gr",
        "69c21aa1f055928f6ddccea7" : "Popetas Mix Caramelo Queso x 44gr",
        "69d6748fb1a817c41903407c" : "Portasopa 16oz x Paquete x 20",
        "69d674725f0010c7d1cc93ba" : "Portasopa 16oz x Unidad",
        "69d7b1b14dbce094f84bb3f1" : "Power Maker x Sobre",
        "69c4bd58cfdc708e2023ee39" : "Prestobarba Bic Confort 3 Hojas",
        "69c4bd35e61fb4357fc405b8" : "Prestobarba Dorco 2 Hojas",
        "69c4bcde126013bf1f5a1ff4" : "Prestobarba Gillette 3 Hojas",
        "69c4bd1f126013bf1f5a34a8" : "Prestobarba Shick 2 Hojas",
        "69c4bdb0309b847b30a48d28" : "Protectores Diarios Extra Largos x 15 Unidades",
        "69c4bdc106882b05665890aa" : "Protectores Diarios Nosotras Extra Largos",
        "69c4bdd31dcfb49c18ae4170" : "Protectores Diarios Nosotras Normal",
        "69c4bd88fd71b5f79fb212f6" : "Protectores Diarios Nosotras Normal x 150 unidades",
        "69c4b93b1b70fbcf1b6f323e" : "Protex Avena x 110gr",
        "69c4b89406882b0566570039" : "Protex Avena x 75gr",
        "69c4b8d3e61fb4357fc253fc" : "Protex Carbón x 75gr",
        "69c4b96a1b70fbcf1b6f3c1d" : "Protex Herbal x 110 gr",
        "69c4b999e61fb4357fc29a84" : "Protex Limpieza Profunda x 110gr",
        "69c4b8bd1b70fbcf1b6edcfe" : "Protex Limpieza Profunda x 75gr",
        "69c4b95106882b0566575551" : "Protex Nutrit Protect x 110gr",
        "69d50c45d35d817d1e9466a6" : "Purina Don Can Adulto x 500gr",
        "69d50c682440c8c597a7976b" : "Purina Don Can Cachorros x 500gr",
        "69d50bdcc7687b049a2495be" : "Purina Don Kat Adulto x 500gr",
        "69d50c2c2440c8c597a71d71" : "Purina Don Kat Gaticos x 500gr",
        "69d7c554788108078f59a08d" : "Quatro 1.5L",
        "69d7c0ad4dbce094f85b63e2" : "Quatro x 400ml",
        "69d90ec7af2108383d2710a6" : "Quesillo Klarens x 200gr",
        "69d90eda65d4204c37031c2d" : "Quesillo Klarens x 400gr",
        "69d90e4bf2b6880f9d982400" : "Queso Costeño x 1000gr",
        "69d90e59af2108383d26aef3" : "Queso Costeño x 250gr",
        "69d90e34def710fb3c88c92c" : "Queso Costeño x 500gr",
        "69d90a263393eb99941a3552" : "Queso Crema Cremosino Alpina x 250gr",
        "69d68de6bedddfd69ad1df84" : "Quipitos",
        "69c36f9620de4f254d31fbfc" : "Raid Max x 174gr",
        "69c36fbd3cce32fbe56d3332" : "Raid Max x 244gr",
        "69c36f66872399ad647527b2" : "Raid x 174gr",
        "69c36f831b70fbcf1bc5e15e" : "Raid x 244gr",
        "69c2179cf055928f6ddc177b" : "Recipiente Coprologico",
        "69c21767335b9ea55fecb407" : "Recipiente De Orina",
        "69d8f3c658479361019639b9" : "Red Bull x 250ml",
        "69d90904f2b6880f9d92216c" : "Regeneris Fresa",
        "69d9098165d4204c37fd94e7" : "Regeneris Melocotón",
        "69d3b73d719c4da024d31223" : "Removedor de Esmalte Valny x 50ml",
        "69d6891e42a93f3786c68848" : "Ricato Caramelo x Unidad",
        "69d509639bf0d32ae9a9e963" : "Ricavena Quaker x 55gr",
        "69c36c8f872399ad64748db7" : "Ricostilla Desmenuzado",
        "69c21cf419d90721373dff0d" : "Rizadas Limón x 105gr",
        "69c219c37896dea20a6ff600" : "Rizadas Limón x 250gr",
        "69c21ca57896dea20a707d24" : "Rizadas Limón x 36gr",
        "69c21cce19d90721373dfa55" : "Rizadas Mayonesa x 105gr",
        "69c21a0419d90721373d56d4" : "Rizadas Mayonesa x 250gr",
        "69c21c7af055928f6ddd2b44" : "Rizadas Mayonesa x 36gr",
        "69c21d06817aaac0ae64ef6d" : "Rizadas Pollo x 105gr",
        "69c21cbb9d3d40869966cedb" : "Rizadas Pollo x 36gr",
        "69d7a6d6dde5ad531599fe40" : "Rosquitas",
        "69d7a6ca7a48182babe7a5a0" : "Rosquitas",
        "69c2122f19d90721373aa785" : "Sal De Fruta Lua Plus",
        "69c2121a9d3d408699630a83" : "Sal De Frutas Lua",
        "69d90f8bdef710fb3c89d069" : "Salchicha Cunit Pequeña x Paquete",
        "69d90f2cf600f1b5793c17f3" : "Salchicha Cunit Pequeña x Unidad",
        "69d911cd65d4204c3706ccdf" : "Salchicha Cunit XL x Paquete",
        "69d90f71f2b6880f9d996971" : "Salchicha Cunit XL x Unidad",
        "69d90eb7f2b6880f9d9882fb" : "Salchicha Ranchera x 5",
        "69d51ec1c7687b049a3995a7" : "Salchicha Viena Zenu",
        "69d51ea26b3269bbe4dd2d29" : "Salchicha Viena Zenu Pollo",
        "69d912482ec32e3834785f6c" : "Salchichón Cervecero x 1200gr",
        "69d911f77da5b1ef28b7e997" : "Salchichón Cervecero x Rayita",
        "69d9128765d4204c3707b9c3" : "Salchichón Pollo Zenu x 750gr",
        "69d912713393eb999422d717" : "Salchichón Pollo Zenu x Rayita",
        "69c3699e872399ad6473ba11" : "Salsa 54",
        "69c36708bfb27e5db666e687" : "Salsa BBQ x 170gr",
        "69c36a71872399ad6473e5ee" : "Salsa Con Ají Bary x 165gr",
        "69c36a25872399ad6473d106" : "Salsa De Soya Selecto x 165ml",
        "69c369c31b70fbcf1bc4a8a7" : "Salsa De Tomate Bary x 40gr",
        "69c36a391b70fbcf1bc4c1e1" : "Salsa Inglesa Selecto x 165ml",
        "69c36981bfb27e5db6675521" : "Salsa Negra",
        "69c36acdfd71b5f79f04cfe9" : "Salsa Negra San Jorge x 7ml",
        "69c36a046a7528a70c1d3960" : "Salsa Negra Selecto x 165ml",
        "69c366a620de4f254d3081e4" : "Salsa Rosada Bary x 140gr",
        "69c365f7872399ad6472c350" : "Salsa Tomate Bary x 150gr",
        "69c36b92a88b9bc519bcfa4a" : "Salsita Color x 1gr",
        "69c36ba5bfb27e5db667aa24" : "Salsita Color x 50 sobres",
        "69d521fdd35d817d1eae5554" : "Sardinas Vam Camps x 425gr",
        "69d8f83442a93f3786d0cf76" : "Saviloe x 320ml",
        "69d5154cdeafcfb1d1892f09" : "Servilleta Doble Nube",
        "69c2100b9d3d408699612213" : "Sevedol Extra Fuerte",
        "69d3b50549248df9f806115d" : "Shampoo Head & Shoulders 2 En 1 x 18ml",
        "69d3b4e25e7da3a2f6ffdf8a" : "Shampoo Head & Shoulders Menta Refrescante x 15ml",
        "69d3b61cdeafcfb1d1e78e37" : "Shampoo Head & Shoulders x 18ml",
        "69d3b3d149248df9f804d8eb" : "Shampoo Nutribela 15 Con Células Madres x 18ml",
        "69d3b38bdeafcfb1d1e4e15d" : "Shampoo Nutribela 15 Reparación Intensiva x 15ml",
        "69d3b59c337ef3c0ce152e3d" : "Shampoo Pantene Biotinamina B3 x 18ml",
        "69d3b6344cb3c5886206bea0" : "Shampoo Pantene Con Colágeno x 18ml",
        "69d3b5312440c8c5971d6527" : "Shampoo Pantene Restauración x 18ml",
        "69d3b23fdeafcfb1d1e3fbc3" : "Shampoo Savital Aceite de Argan Y Sábila x 25ml",
        "69d3ba195e7da3a2f604e744" : "Silicona Capilar x 8ml",
        "69d7aa39dde5ad53159d538b" : "Smirnoff x 275ml",
        "69c37523fd71b5f79f06fcc1" : "Sofflin x 500ml",
        "69d8f31b42a93f3786cca375" : "Spartan Xtreme x 310ml",
        "69d8f367695e2ef9f7b50525" : "Speed Max x 310ml",
        "69d3b7e9deafcfb1d1e8b9bd" : "Speed Stick x 8gr",
        "69d7c5634dbce094f861204d" : "Sprite 1.5L",
        "69d7c0d1431c78815076d218" : "Sprite x 400ml",
        "69d7b1c995734f580fe64e44" : "Starbien x Sobre",
        "69c4beb27362d1fe0b8c1f15" : "Stayfree x 12 Unidades",
        "69d7ab36556e98214765514d" : "Stella Artois x 269ml",
        "69d7aa2005edc105d45170df" : "Stella Artois x 300ml",
        "69c375177896dea20a099a95" : "Suavitel x 180ml",
        "69d90c5e65d4204c3700e471" : "Submarino Bimbo Arequipe",
        "69d90c4daf2108383d2495f9" : "Submarino Bimbo Fresa",
        "69d91507f2b6880f9d9fd3fa" : "Suero Costeño 5L",
        "69d90e8b7da5b1ef28b49843" : "Suero Costeño x 400gr",
        "69d90e6af2b6880f9d98327d" : "Suero Klarens x 200gr",
        "69d90e783393eb99941ed516" : "Suero Klarens x 400gr",
        "69d3bd97337ef3c0ce1cf54b" : "SunTea Durazno",
        "69d3bdf86d06a3361b55ce41" : "SunTea Frutos Rojos",
        "69d3bdba337ef3c0ce1d0cee" : "SunTea Maracuyá",
        "69d3bdcc4cb3c588620ca58f" : "SunTea Mora",
        "69d68a0ecced254ef4334c43" : "Super Coco x 100 Unidades",
        "69d689f82c4e357a854b2186" : "Super Coco x Unidad",
        "69d90cd0b200cc804d9bf163" : "Takis Blue Heat x 50gr",
        "69d90cdeaf2108383d251a75" : "Takis Fuego x 50gr",
        "69d68ecbbedddfd69ad37fe8" : "Tamarindo x 50 Unidades",
        "69d68ebc8ca23c3471c0738b" : "Tamarindo x Unidad",
        "69d8f915376bb5d93ead1c42" : "Tampico Naranja 1L",
        "69d8f92842a93f3786d19ef5" : "Tampico Naranja 2L",
        "69d8f822e4843af3b4f2b521" : "Tampico Naranja x 200ml",
        "69d8f809695e2ef9f7b94b7f" : "Tampico Naranja x 330ml",
        "69c2158f19d90721373c0005" : "Tapabocas",
        "69d677e742a93f3786a7eaf9" : "Tenedor x 100 Unidades",
        "69c223fff055928f6dde02cc" : "Ticos Natural x 38gr",
        "69c225bc9d3d408699683816" : "Ticos Picante x 38gr",
        "69c225cf817aaac0ae665a33" : "Ticos Pollo x 38gr",
        "69c225a119d90721373f4c9f" : "Ticos Queso x 38gr",
        "69c22682f055928f6dde4f5b" : "Tocinetas x 25gr",
        "69c372d2a88b9bc519bf0921" : "Top Terra x 230gr",
        "69d7a68842a93f37862277dc" : "Tostadas Ajo",
        "69d7a67c556e982147620314" : "Tostadas Dulces",
        "69d90d58def710fb3c879107" : "Tostadas Integral Bimbo",
        "69d7a698788108078f36f872" : "Tostadas Integrales",
        "69d90cf069b309cf44a57e06" : "Tostadas Mantequilla Bimbo",
        "69c221b97bff33f4a322034d" : "Tosti Limón x 28gr",
        "69c221a7fd71b5f79f613ac3" : "Tosti Nacho x 28gr",
        "69d3b4936d06a3361b4bd476" : "Tratamiento Nutribela 15 Con Biokeratina x 27ml",
        "69d3b4494cb3c5886204f58e" : "Tratamiento Nutribela 15 Con Células Madres x 27ml",
        "69d3b470deafcfb1d1e5ccab" : "Tratamiento Nutribela 15 Con Enzimoterapia x 27ml",
        "69d3b434337ef3c0ce1391d9" : "Tratamiento Nutribela 15 Con Termo protección x 27ml",
        "69d3b4152440c8c5971c5732" : "Tratamiento Nutribela 15 Reparación Intensiva x 27ml",
        "69d3b5c66b3269bbe44161ce" : "Tratamiento Pantene Pro Vitaminas x 30ml",
        "69d68c4d42a93f3786cf8b94" : "Trident Menta 3S",
        "69d68c5fbedddfd69acdf5a2" : "Trident Menta 5S",
        "69d68c23cced254ef43a9cd5" : "Trident Sandía 3S",
        "69d68c352c4e357a8551027d" : "Trident Sandía 5S",
        "69c36b6d7896dea20a07c555" : "Trifogon x 24 sobres",
        "69c36b5175e6fcf877e2d105" : "Trifogon x 2gr",
        "69d68d7c2c4e357a85535971" : "Tumix x Unidad",
        "69d8f94358479361019ade7e" : "Tutti Frutti Naranja 2.L",
        "69d8f95a4dbce094f8eb53e3" : "Tutti Frutti Tropical 2L",
        "69d8f67eb36510b69a6194a6" : "Uva Postobon 1.5L",
        "69c374e175e6fcf877e49277" : "Vanish Blanco Total x 130ml",
        "69c374d0bfb27e5db6697fd0" : "Vanish Color x 130ml",
        "69c37214bfb27e5db6693290" : "Varsol Con Aroma x 150ml",
        "69c371ec7896dea20a092424" : "Varsol Con Aroma x 400ml",
        "69c37207872399ad647584d6" : "Varsol Puro x 150ml",
        "69c371da20de4f254d327b69" : "Varsol Puro x 400ml",
        "69d3b7ce6d06a3361b4f8aa5" : "Vaselina x 30gr",
        "69d6754dcced254ef40db883" : "Vaso 1.75oz x 50 Unidades",
        "69d675dccced254ef40e61be" : "Vaso 10oz x 50 Unidades",
        "69d675c65f0010c7d1ce7e41" : "Vaso 12oz x 50 Unidades",
        "69d6756442a93f3786a44867" : "Vaso 3.0oz x 50 Unidades",
        "69d676d1125e0f80538c8dec" : "Vaso 5.5oz x 50 Unidades",
        "69d67643bedddfd69aa5608d" : "Vaso 7oz x 50 Unidades",
        "69d675ed8ca23c3471936b2b" : "Vaso 9oz x 50 Unidades",
        "69c214f2335b9ea55febed87" : "Vick Vaporub",
        "69d521259bf0d32ae9c47f6a" : "Vinagre Blanco x 3000ml",
        "69d50976d35d817d1e91287c" : "Vinagre Blanco x 500ml",
        "69d51032c7687b049a28d249" : "Vino Sansón x 750ml",
        "69d8f888531e7250784ca5b8" : "Vive 100 Sandía x 210ml",
        "69d8f8fd695e2ef9f7ba53ee" : "Vive 100 Ultra x 380ml",
        "69d8f8ecb0fb5071dc9f032a" : "Vive 100 x 380ml",
        "69c211f6f055928f6dd9e6fd" : "X Ray Dol",
        "69d5204f2440c8c597bcac3b" : "Yodi Sal x 500gr",
        "69d3b6802440c8c5971ea9de" : "Yodora x 12gr",
        "69d90997def710fb3c838f37" : "Yogo Yogo Fresa",
        "69d8fa5d681205cd21d8f037" : "Yogo Yogo Fresa 1L",
        "69d909a7b200cc804d983b8c" : "Yogo Yogo Fresa Con Cereal",
        "69d90a3bf2b6880f9d935a46" : "Yogurt Fitness",
        "69d90de5f2b6880f9d97a3d1" : "Yogurt Griego Fresa Alpina",
        "69d90e0cb200cc804d9d0650" : "Yogurt Griego Mora y Arándanos Alpina",
        "69d90df5af2108383d262841" : "Yogurt Griego Natural Alpina",
        "69d8fb94531e7250784ecc1b" : "Yogurt Klarens Arequipe Con Pasas",
        "69d900d642a93f3786d7d7aa" : "Yogurt Original Fresa",
        "69d900c9b0fb5071dca5d5d8" : "Yogurt Original Fresa 1L",
        "69d90dce3393eb99941de30d" : "Yox Con Defensis",
        "69c227a3335b9ea55ff0199f" : "Zucaritas x 36gr",
        "69c3734b20de4f254d32b1a7" : "Único Plus Lavanda x 220gr",
        "69c373733cce32fbe56da967" : "Único Plus Limón x 280gr"
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
    } else if (decryptedBody.screen === 'RECOMMEND' || decryptedBody.screen === "RATE") {
      screenResponse = await nextEncuesta(decryptedBody);
    }
    // handle health check request
    if (decryptedBody.action === "ping") {
      screenResponse = await getNextScreen(decryptedBody);
    }
    ventana = decryptedBody.screen
    if (ventana === "SUMMARY") {
      datosPedido["datos"] = decryptedBody.data
    }

    res.send(encryptResponse(screenResponse, aesKeyBuffer, initialVectorBuffer));
    
  };

  async handleEvent(req, res) {
    try {
      const event = req.body;
      if (event && event.data && event.data.transaction) {
        await messageHandler.handleWompiEvent(event.data.transaction);
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