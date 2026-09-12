import { PrismaClient } from '@prisma/client';
import { isProduction } from '../config/env.js';

const globalForPrisma = globalThis;

const prisma =
  globalForPrisma.__crmPrisma ??
  new PrismaClient({ log: isProduction ? ['warn', 'error'] : ['warn', 'error'] });

if (!isProduction) globalForPrisma.__crmPrisma = prisma;

export default prisma;
