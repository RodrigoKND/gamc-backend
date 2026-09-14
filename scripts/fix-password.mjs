#!/usr/bin/env node
// Fix de password para usuarios/guardias creados manualmente
// Uso:
//   node scripts/fix-password.mjs --usuario maria --password "MiPass#2025"
//   node scripts/fix-password.mjs --email maria.rojas@cochabamba.bo --password "MiPass#2025"
//   node scripts/fix-password.mjs --guardia b.choque --password "Guardia#2025"
//
// Genera el hash con bcryptjs cost 12 (igual que PasswordService) y actualiza la BD.

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const BCRYPT_ROUNDS = 12;

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    if (k.startsWith('--')) {
      const key = k.slice(2);
      const val = args[i+1] && !args[i+1].startsWith('--') ? args[++i] : 'true';
      out[key] = val;
    }
  }
  return out;
}

const opts = parseArgs();
const plainPassword = opts.password || opts.pass || opts.p;
const identifier = opts.usuario || opts.email || opts.user || opts.guardia;

if (!plainPassword || !identifier) {
  console.error(`Uso:
  node scripts/fix-password.mjs --usuario <usuario|email> --password "<nueva password>"
  node scripts/fix-password.mjs --email <email> --password "<nueva password>"
  node scripts/fix-password.mjs --guardia <usuario_guardia> --password "<nueva password>"

Ejemplos:
  node scripts/fix-password.mjs --usuario maria --password "SuperAdmin#2025"
  node scripts/fix-password.mjs --email maria.rojas@cochabamba.bo --password "SuperAdmin#2025"
  node scripts/fix-password.mjs --guardia b.choque --password "Guardia#2025"
`);
  process.exit(1);
}

const isGuardia = !!opts.guardia;

const db = new PrismaClient();

async function main() {
  const hash = await bcrypt.hash(plainPassword, BCRYPT_ROUNDS);
  console.log(`Hash generado (bcrypt cost ${BCRYPT_ROUNDS}): ${hash}`);
  console.log(`Verificación self-test: ${await bcrypt.compare(plainPassword, hash) ? 'OK' : 'FAIL'}`);

  if (isGuardia) {
    const guardia = await db.guardia.findFirst({ where: { usuario: { equals: identifier, mode: 'insensitive' } } });
    if (!guardia) {
      console.error(`No se encontró guardia con usuario="${identifier}"`);
      process.exit(2);
    }
    await db.guardia.update({
      where: { id: guardia.id },
      data: { passwordHash: hash, estado: 'activo', debeCambiarPassword: false },
    });
    console.log(`Guardia "${guardia.usuario}" (${guardia.id}) actualizado. Ya puedes loguearte en /api/mobile/auth/login con tipo:"guardia"`);
  } else {
    const user = await db.user.findFirst({
      where: { OR: [{ email: { equals: identifier, mode: 'insensitive' } }, { usuario: { equals: identifier, mode: 'insensitive' } }] },
    });
    if (!user) {
      console.error(`No se encontró user con usuario/email="${identifier}"`);
      // listar disponibles
      const all = await db.user.findMany({ select: { usuario: true, email: true } });
      console.log("Usuarios disponibles:", all);
      process.exit(2);
    }
    await db.user.update({
      where: { id: user.id },
      data: { passwordHash: hash, estado: 'activo', debeCambiarPassword: false },
    });
    console.log(`Usuario "${user.usuario}" <${user.email}> (${user.id}) actualizado. Ya puedes loguearte en POST /api/auth/login`);
    console.log(`Prueba: { "identifier": "${identifier}", "password": "${plainPassword}" }`);
  }
}

try { await main(); } catch(e) { console.error(e); process.exit(1); } finally { await db.$disconnect(); }
