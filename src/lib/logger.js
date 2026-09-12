import pino from 'pino';
import env, { isProduction } from '../config/env.js';

const logger = pino({
  level: env.LOG_LEVEL,
  transport: isProduction
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } },
  redact: {
    paths: ['req.headers.authorization', 'req.headers["x-bot-key"]', '*.accessToken', '*.accessTokenEnc'],
    censor: '[oculto]',
  },
});

export default logger;
