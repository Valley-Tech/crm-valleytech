import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import env from '../../config/env.js';

const router = Router();
const legalDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../public/legal');

/**
 * Configuración que la interfaz necesita antes de iniciar sesión.
 * Solo datos públicos: el App ID de Meta ya es visible en el SDK de todos modos.
 */
router.get('/api/config/public', (req, res) => {
  res.json({
    appName: 'CRM ValleyTech',
    metaAppId: env.META_APP_ID,
    metaGraphVersion: env.META_API_VERSION,
    embeddedSignupConfigId: env.META_EMBEDDED_SIGNUP_CONFIG_ID || null,
    publicUrl: env.PUBLIC_URL,
  });
});

// Páginas legales exigidas por la revisión de Meta. Deben ser públicas.
router.get(['/privacidad', '/privacy'], (req, res) => res.sendFile(path.join(legalDir, 'privacidad.html')));
router.get(['/terminos', '/terms'], (req, res) => res.sendFile(path.join(legalDir, 'terminos.html')));

export default router;
