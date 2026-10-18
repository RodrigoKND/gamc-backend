# GAMC API — Plataforma de Seguridad Ciudadana

> Backend de la **Dirección de Seguridad Ciudadana del Gobierno Autónomo Municipal de Cochabamba (GAMC)**.
> Da servicio a la plataforma web de monitoreo y a la app móvil de guardias municipales.

| | |
|---|---|
| **Versión** | 1.0.0 |
| **Stack** | Node.js ≥ 20 · TypeScript 5 (ESM) · Express 4 · Prisma 5 · PostgreSQL (Supabase) · Socket.io 4 · Cloudflare R2 |
| **Puerto por defecto** | `4000` (HTTP + WebSocket sobre el mismo puerto) |
| **Base de la API** | `/api` |
| **Estado** | En desarrollo activo — entregas F1–F7 integradas |

---

## Qué hace

El sistema coordina el patrullaje municipal en tiempo real:

- **Seguimiento GPS en vivo** de los guardias en servicio, con alertas **SOS** empujadas al instante a los operadores.
- **Motor de asignación de rutas** transaccional e idempotente: rutas por calles, puntos fijos, capacidad por modalidad (coche, moto, a pie…).
- **Estado respecto a la ruta** calculado en cada ping GPS: *incorporándose → en ruta → advertencia → alerta*, con plazo de incorporación.
- **Programación de rutas** por días y horas con un **planificador** de servidor que abre, inicia y cierra horarios cada minuto, y **asignación automática** de los guardias libres más cercanos.
- **Registro de hechos** (incidentes) desde la app, con evidencia foto/video almacenada en **Cloudflare R2**, clasificación territorial y tablero de KPIs.
- **Segmentación territorial por EPI** (Estación Policial Integral): cada operador ve y modifica solo lo de su jurisdicción.
- **RBAC** por rol y recurso, sesión con cookies httpOnly (web) o Bearer (móvil), CSRF de doble envío, rate limiting y bitácora de auditoría.

## Inicio rápido

```bash
# 1. Dependencias (ejecuta también `prisma generate`)
npm install

# 2. Configuración
cp .env.example .env
#    → completar DATABASE_URL y JWT_SECRET (≥ 32 caracteres)

# 3. Base de datos: migraciones + datos de demostración
npm run db:migrate
npm run db:seed

# 4. Servidor de desarrollo con recarga
npm run dev
```

Verificación:

```bash
curl http://localhost:4000/api/health
# {"data":{"ok":true,"uptimeSeconds":3}}
```

¿No tienes Supabase? Levanta un PostgreSQL local con `docker compose -f compose.yaml up -d` (ver [Guía de desarrollo](docs/07-desarrollo.md#12-base-de-datos-local)).

## Documentación

| Documento | Contenido | Público |
|---|---|---|
| [01 · Arquitectura](docs/01-arquitectura.md) | Visión de sistema, capas, módulos, flujos principales | Todo el equipo |
| [02 · Referencia de la API](docs/02-api-referencia.md) | Todos los endpoints, permisos, contratos y errores | Frontend · Móvil · QA |
| [03 · Seguridad](docs/03-seguridad.md) | Autenticación, sesiones, RBAC, jurisdicción EPI, controles | Seguridad · Backend |
| [04 · Tiempo real](docs/04-tiempo-real.md) | Socket.io: conexión, salas y catálogo de eventos | Frontend · Móvil |
| [05 · Dominio de patrullaje](docs/05-dominio-patrullaje.md) | Motor de asignación, estados de ruta, planificador, automática | Backend · Producto |
| [06 · Modelo de datos](docs/06-modelo-de-datos.md) | Entidades, relaciones, migraciones y reversiones | Backend · DBA |
| [07 · Guía de desarrollo](docs/07-desarrollo.md) | Configuración, convenciones, cómo agregar un módulo, pruebas | Backend |

## Scripts npm

| Comando | Descripción |
|---|---|
| `npm run dev` | Servidor con recarga en caliente (`tsx watch`) |
| `npm run build` | Compila a `dist/` (tsc + resolución de alias + corrección de imports ESM) |
| `npm start` | Ejecuta la compilación (`node dist/server.js`) |
| `npm run typecheck` | Verificación de tipos sin emitir |
| `npm test` / `npm run test:watch` | Pruebas unitarias (Vitest) |
| `npm run db:migrate` | `prisma migrate dev` |
| `npm run db:seed` | Datos de demostración (roles, EPIs, usuarios, guardias, hechos) |
| `npm run db:reset` | Reinicia la BD y vuelve a sembrar — **destructivo** |
| `npm run db:setup` | Setup automatizado (schema + marca de migración + seed) |

## Cuentas de demostración

Creadas por `npm run db:seed`. **Solo para entornos locales; nunca ejecutar el seed en producción.**

| Rol | Correo | Contraseña | EPI |
|---|---|---|---|
| Super Administrador | `maria.rojas@cochabamba.bo` | `SuperAdmin#2025` | — (global) |
| Administrador | `carlos.mendoza@cochabamba.bo` | `Admin#2025` | Central |
| Operador de Monitoreo | `jorge.quispe@cochabamba.bo` | `Operador#2025` | Central |

## Estructura del repositorio

```
gamc-backend/
├── src/
│   ├── server.ts          # Arranque: HTTP + Socket.io + planificador + apagado ordenado
│   ├── app.ts             # Ensamblaje Express: middleware global y routers
│   ├── composition.ts     # Composition root (inyección de dependencias)
│   ├── config/            # Variables de entorno validadas (zod), CORS
│   ├── infrastructure/    # Prisma, logger (pino), realtime (Socket.io)
│   ├── shared/            # Errores, RBAC, cookies, seguridad, validación
│   └── modules/           # Un directorio por dominio (auth, mapas, ejecuciones, …)
├── prisma/
│   ├── schema.prisma      # Modelo de datos
│   ├── migrations/        # 0001 → 0012 (SQL idempotente con verificación)
│   └── seed.ts
├── scripts/               # Setup de BD, datos simulados, utilidades EPI, reversiones SQL
└── docs/                  # Esta documentación
```

## Soporte y contribución

- Lee la [Guía de desarrollo](docs/07-desarrollo.md) antes de abrir un PR.
- Los cambios de esquema van **siempre** como nueva migración en `prisma/migrations/` con su script de reversión en `scripts/sql/revert/`.
- Reporta vulnerabilidades de forma privada al equipo responsable; no abras issues públicos.

---

© Gobierno Autónomo Municipal de Cochabamba — Dirección de Seguridad Ciudadana. Uso interno.
