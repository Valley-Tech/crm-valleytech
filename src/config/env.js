import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value && process.env.NODE_ENV === 'production') {
    throw new Error(`Falta la variable de entorno requerida: ${name}`);
  }
  return value;
}

const config = {
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',

  DATABASE_URL: required('DATABASE_URL'),
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',

  // Config a nivel de app (no cambia por tenant)
  BASE_URL: process.env.BASE_URL || 'https://graph.facebook.com',
  API_VERSION: process.env.API_VERSION || 'v23.0',
  META_APP_ID: required('META_APP_ID'),
  META_APP_SECRET: required('META_APP_SECRET'),
  META_EMBEDDED_SIGNUP_CONFIG_ID: process.env.META_EMBEDDED_SIGNUP_CONFIG_ID || '',

  WEBHOOK_VERIFY_TOKEN: required('WEBHOOK_VERIFY_TOKEN'),
  CREDENTIALS_ENCRYPTION_KEY: required('CREDENTIALS_ENCRYPTION_KEY'),
};

export default config;
