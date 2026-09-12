import 'dotenv/config';
import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/lib/password.js';

/**
 * Crea el primer cliente y su usuario administrador para que puedas entrar al
 * CRM inmediatamente después de instalar. Es idempotente: si ya existe, no
 * duplica nada.
 */

const prisma = new PrismaClient();

const EMAIL = process.env.SEED_EMAIL ?? 'admin@valleytech.local';
const PASSWORD = process.env.SEED_PASSWORD ?? crypto.randomBytes(9).toString('base64url');

async function main() {
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'valleytech' },
    update: {},
    create: { name: 'ValleyTech', slug: 'valleytech', plan: 'pro' },
  });

  const existing = await prisma.user.findFirst({ where: { tenantId: tenant.id, email: EMAIL } });

  if (existing) {
    console.log(`\nEl usuario ${EMAIL} ya existe. No se cambió su contraseña.\n`);
    return;
  }

  await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: EMAIL,
      name: 'Administrador',
      passwordHash: await hashPassword(PASSWORD),
      role: 'owner',
    },
  });

  console.log(
    [
      '',
      '═══════════════════════════════════════════════',
      ' Cliente y usuario creados',
      '═══════════════════════════════════════════════',
      ` Cliente:    ${tenant.name} (${tenant.id})`,
      ` Correo:     ${EMAIL}`,
      ` Contraseña: ${PASSWORD}`,
      '',
      ' Guarda la contraseña: no se vuelve a mostrar.',
      '',
    ].join('\n')
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
