# 07 · Guía de desarrollo

> **Alcance:** entorno local, configuración, convenciones de código, cómo extender el sistema, pruebas y flujo de contribución.
> **Audiencia:** desarrolladores backend.

---

## 1. Entorno local

### 1.1 Requisitos

- Node.js ≥ 20 y npm
- PostgreSQL 14+ (Supabase o Docker)
- `psql` (opcional, para scripts SQL)

### 1.2 Base de datos local

```bash
docker compose -f compose.yaml up -d
# PostgreSQL 16 en 127.0.0.1:5432 · db gamc_seguridad · usuario gamc / gamc_local_dev
```

`.env`:

```dotenv
DATABASE_URL=postgresql://gamc:gamc_local_dev@127.0.0.1:5432/gamc_seguridad
JWT_SECRET=<openssl rand -hex 48>
COOKIE_SECURE=false
CORS_ORIGINS=http://localhost:3000
```

> Hay dos archivos de compose: `compose.yaml` (recomendado, ligado a `127.0.0.1`, credenciales fijas de desarrollo) y `docker-compose.yml` (lee `POSTGRES_*` del `.env` y expone el puerto en todas las interfaces).

### 1.3 Arranque

```bash
npm install
npm run db:migrate      # aplica migraciones
npm run db:seed         # datos de demostración
npm run dev             # http://localhost:4000
```

Datos simulados adicionales (guardias, rutas, turnos, telemetría, hechos): ver [`scripts/sql/README.md`](../scripts/sql/README.md).

### 1.4 Configuración

Todas las variables se validan al arranque en `src/config/env.ts`; un valor inválido detiene el proceso con un mensaje claro.

| Variable | Por defecto | Descripción |
|---|---|---|
| `NODE_ENV` | `development` | `development` · `test` · `production` |
| `PORT` | `4000` | Puerto HTTP + WebSocket |
| `DATABASE_URL` | — (obligatoria) | Cadena de conexión PostgreSQL (Supabase: *Session pooler*, puerto 5432) |
| `JWT_SECRET` | — (obligatoria) | Firma de los JWT, ≥ 32 caracteres. Debe ser idéntica a la del frontend web |
| `ACCESS_TOKEN_MINUTES` | `15` | Vida del token de acceso |
| `REFRESH_TOKEN_DAYS` | `7` | Vida del token de refresco |
| `COOKIE_SECURE` | `false` | `true` cuando se sirve por HTTPS |
| `CORS_ORIGINS` | `http://localhost:3000` | Orígenes web autorizados, separados por coma |
| `DEV_RETURN_RESET_CODE` | `true` | Devuelve el código de recuperación en la respuesta (desarrollo) |
| `RESET_CODE_MINUTES` | `10` | Vigencia del código de recuperación |
| `R2_ACCOUNT_ID` | — | ID de la cuenta de Cloudflare |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | — | Token de API de R2 (permiso *Object Read & Write*) |
| `R2_BUCKET` | — | Bucket donde se guardan fotos y videos |
| `R2_PUBLIC_URL` | — | Dominio público del bucket (propio o `*.r2.dev`) |
| `LOG_LEVEL` | `info` | Nivel de log de pino |
| `DESACTIVAR_VENCIMIENTO_RUTAS` | — | `1` apaga el planificador en esa instancia (mantenimiento) |

**Archivos (fotos y videos):** con las cinco variables `R2_*` definidas, los archivos se suben a Cloudflare R2. Si se dejan todas vacías, en desarrollo se guardan en `./uploads` y se sirven en `/media`. Definir solo algunas detiene el arranque indicando cuáles faltan.

## 2. Convenciones

### 2.1 Lenguaje y estilo

- **TypeScript estricto** (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`), ESM (`"type": "module"`).
- Imports relativos con extensión **`.js`**; entre capas, usar los alias:

| Alias | Ruta |
|---|---|
| `@config`, `@config/*` | `src/config` |
| `@shared`, `@shared/*` | `src/shared` |
| `@infra`, `@infra/*` | `src/infrastructure` |
| `@modules/*` | `src/modules` |

- El **dominio se nombra en español** (guardia, hecho, ejecución, jurisdicción…), igual que la base de datos y la interfaz. Términos técnicos genéricos pueden quedar en inglés (`router`, `handler`).
- Comentarios para explicar el **porqué** (decisión, incidente, restricción de negocio), no el qué.
- Archivos en **UTF-8 sin BOM**.

### 2.2 Reglas de arquitectura

| Regla | Motivo |
|---|---|
| Nunca leer `process.env` fuera de `src/config/env.ts` | Configuración validada en un solo punto |
| Toda entrada se valida con zod mediante `validate(schema, data)` | Errores `VALIDATION_ERROR` uniformes por campo |
| Lanzar `Errors.*` (`AppError`); nunca responder errores a mano | Formato de error único |
| Handlers asíncronos envueltos en `asyncHandler` | Los errores llegan al `errorHandler` |
| Toda ruta protegida: `authenticate` + `authorize(recurso, acción)` o validación en el servicio | El backend es la defensa real |
| Escrituras territoriales: `jurisdiccionDe()`; lecturas: `alcanceDe()` / `alcanceOVacio()` | Segmentación por EPI que falla cerrado |
| `guardiaId` de la app siempre desde `req.principal`, nunca del body | Un guardia solo actúa sobre sí mismo |
| Operaciones de varias escrituras dentro de `withTransaction` | Atomicidad |
| Publicar eventos **después** del commit | No anunciar cambios que se revierten |
| Parámetros de negocio en `config.ts` del módulo | Ajustables sin tocar la lógica |
| Lógica de cálculo como **funciones puras** separadas de la E/S | Testeable sin base de datos |

### 2.3 Respuestas

```ts
res.json({ data });                       // 200
res.status(201).json({ data });           // creación
res.json({ data: rows, meta: { total, page, pageSize } });
throw Errors.forbidden('Mensaje para el usuario.');
```

## 3. Cómo agregar un módulo

Ejemplo: módulo `novedades`.

```
src/modules/novedades/
├── index.ts
├── novedades.routes.ts
├── novedades.service.ts
├── config.ts               # (si tiene parámetros)
└── __tests__/novedades.test.ts
```

```ts
// novedades.routes.ts
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate } from '@shared/index';
import type { TokenService } from '@modules/auth/application/token.service';
import { authenticate, authorize, type AuthRequest } from '@modules/auth/http/middlewares';
import { alcanceDe } from '@modules/mapas/jurisdiccion';
import { crearNovedad, listarNovedades } from './novedades.service.js';

const crearSchema = z.object({ texto: z.string().trim().min(3).max(500) });

export function buildNovedadesRouter(tokens: TokenService): Router {
  const router = Router();
  router.use(authenticate(tokens));

  router.get('/', authorize('novedades', 'ver'), asyncHandler(async (req: AuthRequest, res) => {
    res.json({ data: await listarNovedades(await alcanceDe(req.principal!)) });
  }));

  router.post('/', authorize('novedades', 'crear'), asyncHandler(async (req: AuthRequest, res) => {
    const input = validate(crearSchema, req.body);
    res.status(201).json({ data: await crearNovedad(input, req.principal!.id) });
  }));

  return router;
}
```

Checklist:

1. Montar el router en `src/app.ts` (`app.use('/api/novedades', buildNovedadesRouter(c.tokens))`).
2. Migración `prisma/migrations/00NN_novedades/migration.sql` con tablas **y** filas en `role_permission` para los tres roles; reversión en `scripts/sql/revert/`.
3. Reflejar el modelo en `schema.prisma` y regenerar el cliente (`npx prisma generate`).
4. Registrar acciones sensibles con `logAudit`.
5. Si emite eventos en vivo, agregarlos a `EVENTS` en `infrastructure/realtime.ts` y usar `publish` (global) o `publishTerritorial` (por EPI).
6. Pruebas unitarias de la lógica pura.
7. Documentar endpoints en [02 · Referencia de la API](02-api-referencia.md), permisos en [03 · Seguridad](03-seguridad.md) y eventos en [04 · Tiempo real](04-tiempo-real.md).

## 4. Pruebas

```bash
npm test            # una ejecución
npm run test:watch  # modo observación
npm run typecheck
```

- **Framework:** Vitest, entorno `node`, archivos `src/**/*.test.ts`.
- `vitest.setup.ts` define variables mínimas (`JWT_SECRET`, `DATABASE_URL` ficticia), de modo que las pruebas **no requieren base de datos**.
- `auth` usa un repositorio en memoria (`InMemoryAuthRepository`); el resto prueba funciones puras o servicios con Prisma simulado.

Cobertura actual:

| Suite | Qué verifica |
|---|---|
| `auth/application/__tests__/auth.service.test.ts` | Login, rotación de refresh, detección de reuso, recuperación |
| `auth/http/__tests__/mobile.routes.test.ts` | Contrato móvil, incluido `INVALID_CREDENTIALS → 400` |
| `ejecuciones/__tests__/estadoRuta.test.ts` | Estados de ruta, umbrales y plazo de incorporación |
| `mapas/__tests__/jurisdiccion.test.ts` | Contención de trazados y puntos en EPIs |
| `programacion/__tests__/automatica.test.ts` | Selección de candidatos de la automática |
| `turnos/__tests__/recorridos.test.ts` | Recorte de recorridos por EPI |
| `guardias/__tests__/guardias.service.test.ts` | Atención de SOS |
| `media/__tests__/media.storage.test.ts` | Subida a Cloudflare R2 y URL pública devuelta |
| `shared/__tests__/shared.test.ts` | Primitivas de seguridad y utilidades |

## 5. Scripts de soporte

| Script | Uso |
|---|---|
| `scripts/setup-db.mjs` | Setup local desde cero (recrea el esquema a partir de un `schema.sql`, indicado con `DB_SCHEMA_SQL`). Solo desarrollo |
| `scripts/fix-password.mjs` | Restablece la contraseña de un usuario o guardia |
| `scripts/seed-sim-prisma.mjs`, `scripts/run-seed-sim.mjs` | Carga de datos simulados |
| `scripts/probe-dashboard.mjs` | Sonda manual de los endpoints del dashboard |
| `scripts/fix-esm-imports.mjs` | Post-build: agrega `.js` a los imports emitidos |
| `scripts/epi/generar_catalogo_v2.py` | Genera la migración 0006 a partir de `inventario_epis.json` (no editar 0006 a mano) |
| `scripts/epi/generar_poligonos.py` | Genera polígonos aproximados de EPIs |
| `scripts/sql/*.sql` | Datos simulados y verificación |
| `scripts/sql/revert/*.revert.sql` | Reversiones de 0006–0012 |

## 6. Flujo de contribución

1. Rama desde `main`: `feature/<tema>`, `fix/<tema>`, `redesign/<tema>`.
2. Commits pequeños y descriptivos en español, en modo imperativo ("Agrega plazo de incorporación…").
3. Antes del PR: `npm run typecheck && npm test && npm run build`.
4. El PR describe: problema, solución, migraciones (con reversión), impacto en web/móvil y pasos de verificación.
5. **Cambios incompatibles con la app móvil publicada** (códigos HTTP, forma de respuestas de `/mobile/auth`, `/telemetry`, `/turnos`, `/hechos`) requieren coordinación con el equipo móvil: el APK no se actualiza al instante.
6. Al menos una revisión aprobada antes de fusionar.

### Definición de terminado

- [ ] Tipos y pruebas en verde; build correcto
- [ ] Autorización por rol **y** por EPI revisada
- [ ] Migración aditiva, idempotente, con verificación y reversión
- [ ] Eventos en vivo publicados tras el commit
- [ ] Auditoría de acciones sensibles
- [ ] Documentación actualizada en `docs/`
