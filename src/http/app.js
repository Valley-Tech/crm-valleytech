import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pinoHttp from 'pino-http';
import logger from '../lib/logger.js';
import metaWebhookRoutes from '../webhooks/meta.routes.js';
import healthRoutes from './routes/health.routes.js';
import apiRoutes from './routes/index.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const publicDir = path.join(rootDir, 'public');
// Interfaz React compilada (npm run build). Si no existe, cae a la bandeja
// básica de public/index.html para que el servidor nunca quede sin interfaz.
const webDist = path.join(rootDir, 'web', 'dist');
const hasWebBuild = fs.existsSync(path.join(webDist, 'index.html'));

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.use(
    helmet({
      // La bandeja incluida es una sola página con su CSS y JS en línea.
      // Si la sustituyes por un frontend aparte, vuelve a activar la CSP.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    })
  );
  app.use(cors({ origin: true, credentials: true }));
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));

  app.use(healthRoutes);

  // IMPORTANTE: el webhook va ANTES del parser JSON global porque necesita el
  // cuerpo crudo para verificar la firma HMAC de Meta. Si express.json()
  // corriera primero, ya habría consumido el stream.
  app.use(metaWebhookRoutes);

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use(apiRoutes);

  if (hasWebBuild) {
    app.use(express.static(webDist, { index: false, maxAge: '1h' }));
    // SPA: cualquier ruta que no sea API ni webhook devuelve index.html y React enruta.
    app.get(/^(?!\/api|\/webhooks|\/health|\/socket\.io).*/, (req, res) =>
      res.sendFile(path.join(webDist, 'index.html'))
    );
  } else {
    logger.warn('web/dist no existe: sirviendo la bandeja básica de public/. Ejecuta npm run build.');
    app.use(express.static(publicDir));
    app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
