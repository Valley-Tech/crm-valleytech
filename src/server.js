import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import config from './config/env.js';
import webhookRoutes from './routes/webhook.routes.js';
import healthRoutes from './routes/health.routes.js';
import './queue/worker.js'; // arranca el worker de BullMQ en el mismo proceso (separar en producción)

const app = express();

app.use(helmet());
app.use(pinoHttp());

app.use(healthRoutes);

// El webhook se registra ANTES del parser JSON global: internamente usa
// express.raw() para poder verificar la firma HMAC sobre el body crudo.
// Si express.json() se ejecutara primero, ya habría consumido el stream
// y el body crudo llegaría vacío a verifyMetaSignature.
app.use(webhookRoutes);

// El resto de rutas de la API del CRM sí puede usar JSON normal.
app.use(express.json({ limit: '5mb' }));

app.use((err, req, res, next) => {
  req.log?.error(err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

app.listen(config.PORT, () => {
  console.log(`CRM WhatsApp escuchando en el puerto ${config.PORT}`);
});
