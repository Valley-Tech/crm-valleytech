import express from 'express';
import webhookController from '../controllers/webhookController.js';
import { createCrmEventsRouter } from '../services/crmAdapter.js';

const router = express.Router();

router.post('/flow', webhookController.handleFlow);
router.post('/webhook', (req, res) => webhookController.handleIncoming(req, res)); // función flecha: conserva 'this'
router.get('/webhook', webhookController.verifyWebhook);
router.post('/wompi', express.json({ type: '*/*' }), webhookController.handleEvent);

// Modo gateway: el CRM entrega aquí los mensajes (endpointUrl = https://<bot>/crm/events).
router.use('/crm', createCrmEventsRouter((event) => webhookController.handleCrmEvent(event)));

export default router;