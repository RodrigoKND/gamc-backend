// Seed de datos GAMC (idempotente).
//
//  · Estructural: roles + role_permission (matriz del schema.sql), EPIs y
//    tipo_hecho — mínimo requerido por la app.
//  · Demo: cuentas que hoy se reproducen hardcodeadas en el frontend
//    (maria.rojas / carlos.mendoza / jorge.quispe) + 2 guardias de muestra.
//    Contraseñas hashadas con bcrypt (cost 12, igual que PasswordService).
//
//  Ejecutar: npm run db:seed   (requiere DATABASE_URL apuntando a la BD)

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const db = new PrismaClient();
const BCRYPT_ROUNDS = 12;

const hash = (plain: string) => bcrypt.hash(plain, BCRYPT_ROUNDS);

const TIPOS_HECHO = [
  ['robo', 'Robo', 10],
  ['asalto', 'Asalto', 20],
  ['atraco', 'Atraco', 30],
  ['hurto', 'Hurto', 40],
  ['violencia', 'Violencia', 50],
  ['emergencia', 'Emergencia', 60],
  ['robo_vehículo', 'Robo de Vehículo', 70],
  ['robo_domicilio', 'Robo a Domicilio', 80],
  ['accidente', 'Accidente', 90],
  ['disturbio', 'Disturbio', 100],
  ['vandalismo', 'Vandalismo', 110],
  ['otro', 'Otro', 999],
] as const;

const EPIS = [
  ['norte', 'EPI Norte'],
  ['central', 'EPI Central'],
  ['sud', 'EPI Sud'],
  ['cona_cona', 'EPI Coña Coña'],
  ['centro_cercado', 'EPI Centro Cercado'],
] as const;

// Matriz role → (recurso, ver, crear, editar, eliminar) — idéntica a la del schema.sql.
const ROLE_PERMISOS: Record<string, ReadonlyArray<readonly [string, boolean, boolean, boolean, boolean]>> = {
  super_admin: [
    ['usuarios', true, true, true, true],
    ['guardias', true, true, true, true],
    ['roles', true, true, true, true],
    ['hechos', true, false, true, false],
    ['patrullaje', true, true, true, true],
    ['mapas', true, false, false, false],
    ['auditoria', true, false, false, false],
    ['reportes', true, false, false, false],
  ],
  admin: [
    ['usuarios', true, false, true, false],
    ['guardias', true, false, true, false],
    ['roles', true, false, true, false],
    ['hechos', true, false, true, false],
    ['patrullaje', true, false, true, false],
    ['mapas', true, false, false, false],
    ['auditoria', true, false, false, false],
    ['reportes', true, false, false, false],
  ],
  operador_monitoreo: [
    ['guardias', true, false, false, false],
    ['hechos', true, false, true, false],
    ['patrullaje', true, true, true, false],
    ['mapas', true, false, false, false],
    ['reportes', true, false, false, false],
  ],
};

const ROLES = [
  ['super_admin', 'Super Administrador', 'Crea cuentas, gestiona roles/permisos, auditoría completa'],
  ['admin', 'Administrador', 'Edita/activa/desactiva usuarios y guardias; no crea cuentas nuevas'],
  ['operador_monitoreo', 'Operador de Monitoreo', 'Mapas en vivo, rutas, estado de hechos, estadísticas'],
] as const;

const USUARIOS = [
  {
    email: 'maria.rojas@cochabamba.bo',
    usuario: 'maria.rojas',
    password: 'SuperAdmin#2025',
    rol: 'super_admin',
    primerNombre: 'María',
    segundoNombre: 'Fernanda' as string | null,
    apellidoPaterno: 'Rojas',
    apellidoMaterno: 'Vargas',
    ci: '4987654',
    telefono: '70123456',
  },
  {
    email: 'carlos.mendoza@cochabamba.bo',
    usuario: 'carlos.mendoza',
    password: 'Admin#2025',
    rol: 'admin',
    primerNombre: 'Carlos',
    segundoNombre: null as string | null,
    apellidoPaterno: 'Mendoza',
    apellidoMaterno: 'Toro',
    ci: '6123456',
    telefono: '71234567',
  },
  {
    email: 'jorge.quispe@cochabamba.bo',
    usuario: 'jorge.quispe',
    password: 'Operador#2025',
    rol: 'operador_monitoreo',
    primerNombre: 'Jorge',
    segundoNombre: null as string | null,
    apellidoPaterno: 'Quispe',
    apellidoMaterno: 'Cruz',
    ci: '5345678',
    telefono: '72345678',
  },
] as const;

const GUARDIAS = [
  {
    usuario: 'b.choque',
    password: 'Guardia#2025',
    primerNombre: 'Benjamín',
    apellidoPaterno: 'Choque',
    apellidoMaterno: 'Huanca',
    ci: '7564321',
    telefono: '73456789',
    fechaNacimiento: new Date('1994-03-12'),
    epi: 'norte',
  },
  {
    usuario: 'k.ferreira',
    password: 'Guardia#2025',
    primerNombre: 'Karen',
    apellidoPaterno: 'Ferreira',
    apellidoMaterno: 'Noa',
    ci: '8123456',
    telefono: '74567890',
    fechaNacimiento: new Date('1996-07-25'),
    epi: 'central',
  },
] as const;

async function main() {
  const pws = await Promise.all(USUARIOS.map((u) => hash(u.password)));
  const guardiaPws = await Promise.all(GUARDIAS.map((g) => hash(g.password)));

  await db.$transaction(async (tx) => {
    for (const [codigo, nombre, descripcion] of ROLES) {
      await tx.role.upsert({ where: { codigo }, update: { nombre, descripcion }, create: { codigo, nombre, descripcion } });
    }

    for (const codigo of Object.keys(ROLE_PERMISOS)) {
      const role = await tx.role.findUniqueOrThrow({ where: { codigo } });
      await tx.rolePermission.deleteMany({ where: { roleId: role.id } });
      await tx.rolePermission.createMany({
        data: ROLE_PERMISOS[codigo]!.map(([recurso, puedeVer, puedeCrear, puedeEditar, puedeEliminar]) => ({
          roleId: role.id,
          recurso,
          puedeVer,
          puedeCrear,
          puedeEditar,
          puedeEliminar,
        })),
      });
    }

    for (const [codigo, nombre] of EPIS) {
      await tx.epi.upsert({ where: { codigo }, update: { nombre }, create: { codigo, nombre } });
    }

    for (const [codigo, label, orden] of TIPOS_HECHO) {
      await tx.tipoHecho.upsert({ where: { codigo }, update: { label, orden }, create: { codigo, label, orden } });
    }

    let mariaId = '';

    for (let i = 0; i < USUARIOS.length; i++) {
      const u = USUARIOS[i]!;
      const role = await tx.role.findUniqueOrThrow({ where: { codigo: u.rol } });
      const user = await tx.user.upsert({
        where: { email: u.email },
        update: { roleId: role.id, passwordHash: pws[i]! },
        create: {
          roleId: role.id,
          primerNombre: u.primerNombre,
          segundoNombre: u.segundoNombre,
          apellidoPaterno: u.apellidoPaterno,
          apellidoMaterno: u.apellidoMaterno,
          email: u.email,
          usuario: u.usuario,
          ci: u.ci,
          telefono: u.telefono,
          passwordHash: pws[i]!,
          estado: 'activo',
          debeCambiarPassword: false,
        },
      });
      if (u.rol === 'super_admin') mariaId = user.id;
    }

    for (let i = 0; i < GUARDIAS.length; i++) {
      const g = GUARDIAS[i]!;
      const epi = await tx.epi.findUnique({ where: { codigo: g.epi } });
      await tx.guardia.upsert({
        where: { ci: g.ci },
        update: { passwordHash: guardiaPws[i]! },
        create: {
          epiId: epi?.id ?? null,
          primerNombre: g.primerNombre,
          apellidoPaterno: g.apellidoPaterno,
          apellidoMaterno: g.apellidoMaterno,
          ci: g.ci,
          usuario: g.usuario,
          passwordHash: guardiaPws[i]!,
          telefono: g.telefono,
          fechaNacimiento: g.fechaNacimiento,
          estado: 'activo',
          estadoOperativo: 'fuera_de_servicio',
          debeCambiarPassword: false,
          creadoPorId: mariaId,
        },
      });
    }
  });

  await db.$disconnect();
}

main()
  .catch(async (e) => {
    console.error(e);
    await db.$disconnect();
    process.exit(1);
  });