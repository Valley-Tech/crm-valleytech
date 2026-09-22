/**
 * Errores de la Cloud API de WhatsApp explicados en español.
 *
 * Meta devuelve títulos en inglés y muy escuetos ("Re-engagement message").
 * La bandeja los muestra tal cual y nadie sabe qué hacer. Aquí cada código
 * se traduce a qué pasó y qué hacer, para el estado "falló" de un mensaje.
 *
 * Referencia: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 */
const META_ERRORS = {
  131047: 'Fuera de la ventana de 24 h: este número no le escribió al bot en las últimas 24 h, así que WhatsApp solo acepta una plantilla aprobada (no texto libre).',
  131026: 'No se pudo entregar: el número no tiene WhatsApp, bloqueó al negocio o no aceptó los términos nuevos de WhatsApp.',
  131049: 'WhatsApp limitó este envío para no saturar al usuario con mensajes de marketing. Reintenta más tarde.',
  131050: 'El usuario pidió no recibir mensajes de marketing de este negocio.',
  131048: 'Envío bloqueado por límite de spam: la calidad del número bajó. Revisa la calidad en WhatsApp Manager.',
  131056: 'Demasiados mensajes al mismo número en poco tiempo. Se reintenta solo.',
  131053: 'No se pudo subir el archivo adjunto (tipo o tamaño no admitido por WhatsApp).',
  131052: 'No se pudo descargar el archivo adjunto.',
  131051: 'Tipo de mensaje no admitido.',
  131031: 'La cuenta de WhatsApp Business está restringida o suspendida por incumplir las políticas.',
  131030: 'El número destino no está en la lista de destinatarios permitidos (número de prueba).',
  131021: 'El remitente y el destinatario son el mismo número.',
  131009: 'Un parámetro del mensaje no es válido (revisa el formato del contenido).',
  131008: 'Falta un parámetro obligatorio en el mensaje.',
  131000: 'Error interno de WhatsApp al enviar. Reintenta.',
  132000: 'La plantilla espera otra cantidad de variables: las que se enviaron no coinciden con las de la plantilla aprobada.',
  132001: 'La plantilla no existe en ese idioma o no está aprobada para este número.',
  132005: 'El texto de la plantilla traducido es demasiado largo.',
  132007: 'El contenido de la plantilla incumple las políticas de WhatsApp.',
  132012: 'El formato de una variable de la plantilla no es válido (saltos de línea, tabulaciones o más de 4 espacios seguidos).',
  132015: 'La plantilla está pausada por baja calidad.',
  132016: 'La plantilla está desactivada por baja calidad.',
  132068: 'El Flow está bloqueado.',
  132069: 'El Flow está limitado: el porcentaje de errores del endpoint es demasiado alto.',
  133010: 'El número no está registrado en la Cloud API. Regístralo en Números de WhatsApp.',
  133005: 'PIN de verificación en dos pasos incorrecto.',
  133006: 'Hay que verificar el número de nuevo antes de registrarlo.',
  133004: 'El servidor de Meta no está disponible por el momento. Reintenta.',
  130429: 'Se alcanzó el límite de mensajes por segundo. Se reintenta solo.',
  130472: 'El usuario forma parte de un experimento de Meta y no recibe mensajes de marketing.',
  100: 'Parámetro inválido en la llamada a Meta (revisa el contenido del mensaje).',
  190: 'El token de acceso venció o fue revocado: reconecta el número en Números de WhatsApp.',
  10: 'El token no tiene permiso para esta acción (revisa los permisos del usuario del sistema).',
  200: 'El token no tiene permiso para esta acción.',
  4: 'Se alcanzó el límite de llamadas a la API. Se reintenta solo.',
  80007: 'Límite de tasa de la cuenta de WhatsApp Business alcanzado. Se reintenta solo.',
  368: 'El negocio está bloqueado temporalmente por incumplir políticas.',
  470: 'Fuera de la ventana de 24 h: solo se acepta una plantilla aprobada.',
};

/** Texto en español para un error de Meta, o el título original si no está catalogado. */
export function describeMetaError(code, fallback = '') {
  const known = META_ERRORS[Number(code)];
  const original = String(fallback ?? '').trim();
  if (known) return original && !original.startsWith(known) ? `${known} (${original}, código ${code})` : `${known} (código ${code})`;
  return original ? (code ? `${original} (código ${code})` : original) : code ? `Error ${code} de WhatsApp` : 'Error desconocido de WhatsApp';
}

export default META_ERRORS;
