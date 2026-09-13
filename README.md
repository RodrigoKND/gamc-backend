# GAMC API — Seguridad Ciudadana

Backend de la plataforma de la **Dirección de Seguridad Ciudadana del Gobierno
Autónomo Municipal de Cochabamba (GAMC)**. API REST (Express 4 + TypeScript) con
Supabase (PostgreSQL, vía Prisma ORM), autenticación JWT con rotación de refresh, RBAC por rol,
Socket.io para telemetría en tiempo real y rate limiting en login/recuperación.

- **Puerto:** `4000`
- **Estado:** en desarrollo. Ver la sección [Scripts](#scripts).

---

## Requisitos

- **Node.js ≥ 20**
- **Un proyecto de [Supabase](https://supabase.com)** (PostgreSQL 17 gestionado; connection string en Project Settings → Database)

---

## Instalación

```bash
npm install
```

Crea el archivo `.env` copiando `.env.example` y completa los valores reales:

```bash
cp .env.example .env
```

Variables clave:

| Variable | Descripción |
| --- | --- |
| `DATABASE_URL` | Connection string de Supabase, ideal "Session pooler" (puerto 5432, IPv4): `postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres` |
| `JWT_SECRET` | Clave de firma de los JWT (≥32 caracteres). **Debe coincidir** con la del frontend (`GAMC/.env.local`) |
| `ACCESS_TOKEN_MINUTES` | Vida del access token en minutos (default `15`) |
| `REFRESH_TOKEN_DAYS` | Vida del refresh token en días (default `7`) |
| `CORS_ORIGINS` | Orígenes permitidos, separados por coma (nunca `*` en producción) |
| `COOKIE_SECURE` | `false` en local (`http://localhost`), `true` en HTTPS |
| `DEV_RETURN_RESET_CODE` | `true` devuelve el código de recuperación en la respuesta (solo dev) |

> Genera un secreto con:
> `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`

---

## Base de datos (Supabase)

1. Crea (o usa) un proyecto en [supabase.com](https://supabase.com).
2. Copia el connection string (Project Settings → Database → "Session pooler")
   a `DATABASE_URL` en `.env`.
3. Prepara el schema con una de estas dos formas equivalentes:

```bash
# Opción A — setup automatizado (carga schema, marca migración, corre seed)
npm run db:setup

# Opción B — migraciones + seed de Prisma
npm run db:migrate
npm run db:seed
```

Todos los comandos usan la BD `postgres` del proyecto Supabase apuntado por
`DATABASE_URL`. Ver [prisma/migrations](/prisma/migrations) y `scripts/setup-db.mjs`.

---

## Ejecución

```bash
npm run dev        # tsx watch — reinicia al editar (recomendado en desarrollo)
npm run build      # compila a dist/ con alias de módulos + fix ESM
npm run start      # ejecuta la compilación (dist/server.js)
npm run typecheck  # tsc --noEmit
npm run test       # vitest (unit, en memoria)
```

Los **WebSockets** (Socket.io) comparten el mismo puerto del API y se montan en
`src/server.ts`. El frontend (`localhost:3000`) consume telemetría en vivo por
este canal.

---

## Cuentas de demostración (seed)

| Rol | Correo | Contraseña |
| --- | --- | --- |
| Super Administrador | `maria.rojas@cochabamba.bo` | `SuperAdmin#2025` |
| Administrador | `carlos.mendoza@cochabamba.bo` | `Admin#2025` |
| Operador de Monitoreo | `jorge.quispe@cochabamba.bo` | `Operador#2025` |

Estas cuentas se siembran con bcrypt (cost 12) en `prisma/seed.ts`.

---

## Lo que puede hacer cada usuario (RBAC)

La matriz de permisos vive en `src/shared/policies.ts`, la DB
(`role_permission`) y el seed. Todo recurso tiene 4 acciones:
**ver · crear · editar · eliminar**.

| Recurso | `super_admin` | `admin` | `operador_monitoreo` |
| --- | --- | --- | --- |
| **usuarios** (cuentas del personal) | ver, crear, editar, eliminar | ver, editar | — |
| **guardias** (dotación) | ver, crear, editar, eliminar | ver, editar | ver |
| **roles** / permisos | ver, crear, editar, eliminar | ver, editar | — |
| **hechos** / reportes de incidentes | ver, editar | ver, editar | ver, editar |
| **patrullaje** (asignar patrullas) | ver, crear, editar, eliminar | ver, editar | ver, crear, editar |
| **mapas** (ver ubicaciones/rutas/zonas) | ver | ver | ver |
| **auditoria** (registro de acciones) | ver | ver | — |
| **reportes** (estadísticas / dashboard) | ver | ver | ver |

### En lenguaje llano

- **Super Administrador** — control total: crea cuentas de personal, gestiona
  roles y permisos, crea/edita/elimina guardias, y ve auditoría completa.
- **Administrador** — gestiona el día a día: edita y activa/desactiva usuarios y
  guardias, cambia estados de hechos y asigna patrullas. **No** crea cuentas
  nuevas ni elimina.
- **Operador de Monitoreo** — operativo: ve el mapa en vivo y el estado de la
  dotación, cambia el estado de los hechos y asigna/edita patrullas. **No**
  gestiona cuentas ni permisos.

El **frontend** solo oculta ítems por UX; la defensa real está aquí, en el
middleware `authorize` de `src/modules/auth/http/middlewares.ts`, que valida cada
petición contra la matriz `can(recurso, acción)`.

---

## Autenticación y sesión

Flujo basado en **cookies httpOnly** + JWT:

| Cookie | Tipo | Propósito |
| --- | --- | --- |
| `gamc_access` | httpOnly, JWT corto (`ACCESS_TOKEN_MINUTES`) | Autentica cada endpoint; lo valida el API y el middleware del frontend |
| `gamc_refresh` | httpOnly, **solo viaja a `/api/auth/refresh`** | Rotación de sesión (familia + hash en BD) |
| `gamc_profile` | legible | Perfil no sensible para la UI del cliente |
| `gamc_xsrf` | legible | Token anti-CSRF de doble envío (header `x-csrf-token`) |

- Mutaciones de datos (`POST`/`PATCH`/`DELETE`) exigen `x-csrf-token` (`csrfGuard`).
- Las contraseñas se hashean con **bcrypt (cost 12)**.
- **Rate limiting** (express-rate-limit, `standardHeaders: draft-7`, `Retry-After`):
  - Login: **5 intentos / 30 s** (los exitosos no cuentan).
  - Recuperación: **10 / 15 min**.

---

## Endpoints

Base: `http://localhost:4000/api`

### Salud

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/health` | `{ ok, uptimeSeconds }` — sin autenticación |

### Autenticación (`/auth`)

| Método | Ruta | Descripción |
| --- | --- | --- |
| POST | `/auth/login` | Inicia sesión; emite las 4 cookies. Rate limit 5/30s |
| POST | `/auth/logout` | Cierra sesión y borra cookies |
| POST | `/auth/refresh` | Rota el access (y refresh) con la cookie `gamc_refresh` |
| GET | `/auth/me` | Principal autenticado actual |
| POST | `/auth/recovery/request` | Solicita código de recuperación (rate limit 10/15min) |
| POST | `/auth/recovery/confirm` | Confirma código + nueva contraseña |
| POST | `/auth/change-password` | Cambio de contraseña autenticado (CSRF) |

### Usuarios (`/usuarios`) — requiere `authorize('usuarios', …)`

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/usuarios/roles` | Catálogo de roles |
| GET | `/usuarios` | Lista usuarios |
| POST | `/usuarios` | Crea usuario (devuelve credenciales temporales 201) |
| PATCH | `/usuarios/:id` | Edita datos |
| PATCH | `/usuarios/:id/estado` | `{ estado: activo | inactivo | suspendido }` |

### Guardias (`/guardias`) — requiere `authorize('guardias', …)`

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/guardias` | Lista dotación (incluye última posición y credenciales generadas) |
| GET | `/guardias/:id` | Detalle |
| POST | `/guardias` | Crea guardia (`fechaNacimiento` en `DD/MM/AAAA`) |
| PATCH | `/guardias/:id` | Edita datos |
| PATCH | `/guardias/:id/estado` | Estado de cuenta `activo | inactivo | suspendido` |
| PATCH | `/guardias/:id/estado-operativo` | Estado operativo `en_servicio | fuera_de_servicio | emergencia` |

### Hechos / reportes (`/hechos`) — `authorize('hechos', …)`

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/hechos/tipos` | Catálogo de tipos de hecho |
| GET | `/hechos?q=&tipo=&estado=&epiId=&desde=&hasta=` | Lista con filtros |
| PATCH | `/hechos/:id/estado` | `{ estado: reportado | en_revision | cerrado }` |

### Mapas (`/mapas`) — `authorize('mapas'|'patrullaje', …)`

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/mapas/ubicaciones` | Posiciones actuales de guardias |
| GET | `/mapas/patrullas` | Patrullas vigentes |
| GET | `/mapas/rutas` | Rutas plantilla |
| GET | `/mapas/zonas` | Zonas críticas |
| POST | `/mapas/patrullas` | Asigna patrulla a un guardia (`authorize('patrullaje','crear')`) |

### Dashboard (`/dashboard`) — `authorize('reportes','ver')`

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/dashboard/kpi` | KPIs agregados |
| GET | `/dashboard/series/deficit?dias=N` | Hechos por día (N 1–30, default 7) |
| GET | `/dashboard/series/por-tipo` | Hechos por tipo |
| GET | `/dashboard/series/por-zona` | Hechos por zona |

### Seguridad / telemetría móvil (`/telemetry`) — autenticación válida

| Método | Ruta | Descripción |
| --- | --- | --- |
| POST | `/telemetry` | Ingresa un punto GPS desde la app móvil del guardia (la web recibe lo mismo por Socket.io) |

### Auditoría (`/auditoria`) — `authorize('auditoria', …)`

Histórico de acciones sensibles registradas por el sistema.

---

## Arquitectura

```
src/
 ├─ server.ts            # bootstrap HTTP + WebSocket (Socket.io)
 ├─ app.ts               # ensamblaje Express: middleware global + routers
 ├─ composition.ts       # contenedor de dependencias (DI manual)
 ├─ config/              # env (zod), CORS
 ├─ shared/              # errores, policies (RBAC), cookies, seguridad, helpers
 ├─ infrastructure/      # prisma (db), logger, realtime (socket)
 └─ modules/
     ├─ auth/            # login, refresh, logout, recuperación, RBAC
     ├─ usuarios/        # cuentas del personal
     ├─ guardias/        # dotación y estados
     ├─ hechos/          # reportes de incidentes
     ├─ mapas/           # ubicaciones, rutas, patrullas, zonas
     ├─ dashboard/       # KPIs y series
     ├─ telemetry/       # ingesta GPS móvil
     └─ auditoria/       # bitácora de acciones
```

Cada módulo sigue la misma división por capas:

```
module/
 ├─ http/        # rutas, controladores, middlewares (Express)
 ├─ application/ # casos de uso, servicios, schemas (zod)
 ├─ domain/      # contratos / repositorios
 └─ infrastructure/  # implementación concreta (Prisma)
```

### Concurrencia web ↔ API

- Todos los datos viajan autenticados por la cookie `gamc_access` (el frontend
  reconstruye el header `Cookie` al llamar al API desde el servidor).
- Los **Set-Cookie del API** (rotación, logout) se reenvían al navegador desde
  el frontend para mantener la sesión.
- El refresh es de **ruta restringida** (`Path=/api/auth/refresh`) para que la
  cookie de refresco nunca viaje a otros endpoints.

---

## Notas de seguridad

- `helmet`, `compression`, `cors` con **orígenes explícitos**.
- Contraseñas bcrypt (cost 12); tokens JWT HS256 con `jose`.
- Doble envío CSRF en mutaciones; rate limiting en auth.
- Códigos de recuperación: 6 dígitos, hasheados (sha256) en reposo, un solo uso,
  10 min de vida y anti-enumeración.
