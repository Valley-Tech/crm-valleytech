import prisma from '../db/prisma.js';
import whatsappService from '../services/whatsapp/whatsappService.js';
import { decryptSecret } from '../utils/crypto.js';

/**
 * Motor de árbol de decisión: cada BotFlow tiene BotNode's tipo
 * message | question | condition | action | handoff. El estado de "en qué
 * nodo va cada conversación" se guarda en Conversation.stage por simplicidad
 * en esta primera versión (a futuro puede moverse a una tabla dedicada
 * conversation_state si el árbol crece mucho).
 */
export async function runBotFlow({ tenantId, phoneNumberId, conversation, contact, incomingMessageText }) {
  const flow = await prisma.botFlow.findFirst({
    where: { tenantId, isActive: true },
    include: { nodes: true },
  });

  if (!flow) return; // el tenant no configuró ningún flujo todavía

  const currentNodeId = conversation.stage || flow.nodes[0]?.id;
  const currentNode = flow.nodes.find((n) => n.id === currentNodeId);
  if (!currentNode) return;

  const integration = await prisma.metaIntegration.findUnique({ where: { phoneNumberId } });
  const accessToken = decryptSecret(integration.accessTokenEnc);

  switch (currentNode.type) {
    case 'message': {
      await whatsappService.sendText(phoneNumberId, accessToken, contact.waId, currentNode.config.text);
      await advanceToNextNode(conversation.id, currentNode);
      break;
    }

    case 'question': {
      const buttons = (currentNode.config.options ?? []).map((opt) => ({ id: opt.id, title: opt.label }));
      if (buttons.length > 0) {
        await whatsappService.sendInteractiveButtons(
          phoneNumberId,
          accessToken,
          contact.waId,
          currentNode.config.text,
          buttons
        );
      } else {
        await whatsappService.sendText(phoneNumberId, accessToken, contact.waId, currentNode.config.text);
      }
      // Se queda esperando la respuesta del usuario en este mismo nodo;
      // el siguiente mensaje entrante se evalúa contra currentNode.config.options.
      break;
    }

    case 'condition': {
      const matchedOption = (currentNode.config.options ?? []).find(
        (opt) => opt.matchValue?.toLowerCase() === incomingMessageText?.toLowerCase()
      );
      const nextNodeId = matchedOption?.nextNodeId ?? currentNode.config.fallbackNodeId;
      await prisma.conversation.update({ where: { id: conversation.id }, data: { stage: nextNodeId } });
      // Reprocesa inmediatamente el nuevo nodo (ej. un "message" que sigue a la condición).
      const updated = await prisma.conversation.findUnique({ where: { id: conversation.id } });
      return runBotFlow({ tenantId, phoneNumberId, conversation: updated, contact, incomingMessageText });
    }

    case 'handoff': {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { botActive: false, status: 'pending' },
      });
      // Aquí se dispararía la notificación en tiempo real al panel de agentes (WebSocket).
      break;
    }

    default:
      break;
  }
}

async function advanceToNextNode(conversationId, currentNode) {
  const nextNodeId = currentNode.nextNodeIds?.[0] ?? null;
  await prisma.conversation.update({ where: { id: conversationId }, data: { stage: nextNodeId } });
}
