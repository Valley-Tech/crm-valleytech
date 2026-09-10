import { PrismaClient } from '@prisma/client';

// Singleton para evitar abrir múltiples pools de conexión en desarrollo con --watch
const globalForPrisma = globalThis;

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export default prisma;
