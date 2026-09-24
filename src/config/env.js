import 'dotenv/config';
import { z } from 'zod';

/**
 * Validación de entorno que falla rápido y en bloque.
 *
 * El crash que veías en Railway (P1012: Environment variable not found:
 * DATABASE_URL) ocurría porque nadie comprobaba las variables antes de usarlas.
 * Aquí se validan todas de una vez y el proceso muere con la lista completa de
 * lo que falta, en vez de morir una variable a la vez.
 */

const base64Key = (label) =>
  z
    .string()
    .min(1, `${label} es obligatorio (genéralo con: npm run keygen)`)
    .refine((value) => {
      try {
        return Buffer.from(value, 'base64').length === 32;
      } catch {
        return false;
      }
    }, `${label} debe ser una clave de 32 bytes en base64 (npm run keygen)`);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatorio'),
  REDIS_URL: z.string().min(1, 'REDIS_URL es obligatorio').default('redis://localhost:6379'),

  JWT_SECRET: base64Key('JWT_SECRET'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  CREDENTIALS_ENCRYPTION_KEY: base64Key('CREDENTIALS_ENCRYPTION_KEY'),

  META_APP_ID: z.string().min(1, 'META_APP_ID es obligatorio'),
  META_APP_SECRET: z.string().min(1, 'META_APP_SECRET es obligatorio'),
  META_GRAPH_URL: z.string().url().default('https://graph.facebook.com'),
  META_API_VERSION: z.string().default('v23.0'),
  META_WEBHOOK_VERIFY_TOKEN: z.string().min(8, 'META_WEBHOOK_VERIFY_TOKEN debe tener al menos 8 caracteres'),
  META_EMBEDDED_SIGNUP_CONFIG_ID: z.string().optional().default(''),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  S3_BUCKET: z.string().optional().default(''),
  S3_REGION: z.string().optional().default(''),
  S3_ACCESS_KEY_ID: z.string().optional().default(''),
  S3_SECRET_ACCESS_KEY: z.string().optional().default(''),
  // Para Cloudflare R2, Backblaze B2, MinIO…: URL del endpoint compatible con S3.
  S3_ENDPOINT: z.string().optional().default(''),
  // Convertir notas de voz (ogg/opus) a mp3 si hay ffmpeg. "false" para desactivar.
  MEDIA_TRANSCODE_AUDIO: z.preprocess((v) => (v === undefined || v === '' ? true : String(v) !== 'false'), z.boolean()).default(true),

  BOT_PAUSE_MINUTES: z.coerce.number().int().positive().default(30),
  OUTBOUND_RATE_PER_SECOND: z.coerce.number().int().positive().default(20),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  • ${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
    .join('\n');

  console.error(
    [
      '',
      '════════════════════════════════════════════════════════════',
      ' No se puede arrancar: faltan o son inválidas estas variables',
      '════════════════════════════════════════════════════════════',
      issues,
      '',
      ' Copia .env.example a .env y complétalo. Para las claves:',
      '   npm run keygen',
      '',
    ].join('\n')
  );
  process.exit(1);
}

const env = parsed.data;

if (env.STORAGE_DRIVER === 's3' && !env.S3_BUCKET) {
  console.error('STORAGE_DRIVER=s3 requiere S3_BUCKET, S3_REGION y credenciales.');
  process.exit(1);
}

export const isProduction = env.NODE_ENV === 'production';

export default env;
