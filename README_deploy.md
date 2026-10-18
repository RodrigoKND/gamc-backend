# README_deploy.md — Despliegue a cPanel (gamc-api)

---

## ✦ DEPLOY F1–F7 (el deploy actual)

Esta vez se sube **código nuevo desde `main`** (merge del PR #6) y se aplican
las migraciones **0006 → 0012** de una sola vez.

### Qué trae
- Catálogo de 6 EPIs (0006), ejecuciones de ruta (0007), segmentación por EPI
  (0008), puntos fijos (0009), programación de rutas (0010), asignación
  automática (0011) y plazo de incorporación (0012).
- Módulos nuevos: `/api/epis`, `/api/puntos-fijos`, `/api/programacion`, etc.
- **Planificador**: al arrancar, el server hace una pasada cada minuto (abre y
  cierra horarios programados y vencimientos). No necesita nada extra.

### Archivos de este deploy
| Archivo | Qué es |
|---|---|
| `deploy_cpanel_f1_f7.sql` | TODO el SQL de 0006–0012 en un solo archivo, listo para pegar en phpPgAdmin (una transacción). |
| `gamc-api-deploy-f1-f7.zip` (en tu carpeta `Downloads`) | `dist/` + `node_modules/` de producción + package.json + prisma. 38 MB (sin dev-deps ni cachés). |
| `docs/entrega-f1-f7.md` | Doc del equipo (qué cambia, verificación, reversión). |

### 1) En tu PC
```powershell
git checkout main; git pull
npm install
npx prisma generate
npm run build
```
(Ya quedo hecho y `gamc-api-deploy-f1-f7.zip` armado.)

### 2) Diagnóstico de la BD (phpPgAdmin → SQL)
```sql
SELECT version() AS pg_version;
SELECT to_regprocedure('gen_random_uuid()') IS NOT NULL AS tiene_gen_random_uuid;
SELECT extname FROM pg_extension ORDER BY 1;
SELECT to_regclass('checkpoint') IS NOT NULL AS hay_checkpoint,
       (SELECT count(*) FROM information_schema.columns
          WHERE table_name='user' AND column_name='epi_id') AS hay_epi_id,
       (SELECT count(*) FROM epi WHERE poligono IS NOT NULL) AS epi_con_poligono;
```
- `tiene_gen_random_uuid` = `f` **no es problema**: `deploy_cpanel_f1_f7.sql` crea
  una alternativa al inicio si el Postgres es < 13 sin pgcrypto.
- `hay_checkpoint`=t y `hay_epi_id`=1 confirman que 0001–0005 ya están aplicadas
  (si dan 0/f, primero hay que correr `deploy_cpanel.sql` viejo).

### 3) Respaldar la BD
phpPgAdmin → tu BD → **Export** (o cPanel → Backup). **No saltes este paso.**

### 4) Subir el código
1. File Manager → carpeta de la app → subir `gamc-api-deploy-f1-f7.zip` →
   **Extraer** (sobrescribe `dist/` y `node_modules/`; deja `uploads/` y `.env`
   intactos, **no** pisa el `.env` del server).
2. *Setup Node.js App* → **Restart**.

### 5) Aplicar la BD
phpPgAdmin → tu BD → pestaña **SQL** → pegar **TODO** `deploy_cpanel_f1_f7.sql`
→ **Executar**.
- Es una transacción: si algo falla no queda nada a medias; corregís y reintentás
  pegando el mismo archivo.
- Idempotente: si ya estaba aplicado, no cambia nada.

### 6) Verificación
- `curl https://<tu-api>/api/health` → `ok`.
- `SELECT count(*) FROM planificador_estado;` → 1 (y `ultima_pasada` se actualiza
  cada minuto).
- En la web: mapa OK, asignar ruta (aparece «Incorporándose» y el plazo), programar
  un horario de prueba.

### Rollback (emergencia)
- **Código**: restaurar el ZIP anterior + Restart.
- **BD**: `scripts/sql/revert/entrega_f1_f7.revert.sql` revierte 0012→0006; usa
  `psql` (meta-comandos `\ir`/`\if`). Para phpPgAdmin hay que armarlo mergeado.

---

# (Referencia) Deploy anterior 0001–0005

> **Archivo privado (en `.gitignore`, no sube a git).**
> Flujo real: **subir archivos desde tu PC** (sin terminal en el servidor) +
> **SQL en phpPgAdmin**. La BD ya existe y vive en el mismo cPanel.

---

## 0. Tu duda sobre Prisma y la BD — respuesta corta

- **Prisma NO crea tablas ni corre migraciones solo.** El `postinstall`
  (`prisma generate`) solo genera el cliente TS; igual no corre en el servidor
  si subís `node_modules` ya armado.
- **En tu flujo, los cambios de BD se aplican con un solo archivo SQL** en
  phpPgAdmin: **`deploy_cpanel.sql`** (está en la raíz del repo). Trae **todo**
  lo que le falte a la BD (jurisdicción/EPI + triggers + checkpoint), es
  idempotente = se puede re-ejecutar sin drama.
- Nunca hace falta `npx prisma migrate ...` en el servidor.

---

## 1. Qué cambia en ESTE deploy

**Código:** hechos/mapas (geocoding no bloqueante, `precision_m`), auth
(activación de guardia con auditoría), módulos nuevos **`/api/checkpoints`** y
**`/api/media`** + `/media` (subida de fotos, dependencia nueva `multer`),
endpoint **`GET /api/mapas/jurisdiccion`**.

**Jurisdicción por EPI (PR #2, ya mergeado)** — es lo que arregla el error del
front *"No se pudo cargar la jurisdicción por EPI. Las acciones de rutas quedan
bloqueadas por seguridad."*: el backend viejo de cPanel no tiene el endpoint
`GET /api/mapas/jurisdiccion`, y la BD creada con `schema.sql` no tiene
`user.epi_id` ni polígonos en `epi.poligono`.

**BD (todo aditivo, 6 partes en `deploy_cpanel.sql`):**

| Qué | Parte del archivo |
|---|---|
| `fn_turno_distancia` anti-drift GPS | parte 1 |
| `ruta_plantilla.modalidad` | parte 2 |
| `user.epi_id` + índice (jurisdicción) | parte 3 |
| Polígonos GeoJSON en `epi.poligono` (5 EPIs) | parte 4 |
| 2 triggers (SOS→emergencia, estado de hecho) + CHECK en `turno` | parte 5 |
| enum `checkpoint_estado` + tabla `checkpoint` + 2 índices | parte 6 |

---

## 2. Despliegue — paso a paso

### En tu PC (Windows)

```powershell
git pull origin main
npm install                 # instala multer y todo lo nuevo
npx prisma generate         # genera el cliente con los engines linux (binaryTargets ya los incluye)
npm run build               # genera dist/
```

### Armar el ZIP para subir

Incluir (del proyecto, NO la carpeta del repo con .git):
- `dist/` (recién generado)
- `node_modules/` (recién regenerado — por eso te daba error de prisma antes:
  el cliente y los engines de Linux tienen que venir de TU `prisma generate`)
- `package.json`, `package-lock.json`
- `prisma/schema.prisma` (por las dudas)
- `.env` **de producción** (si ya existe en el servidor, no lo pises)
- **NO** subir `prisma/migrations` es opcional; **NO** borrar `uploads/` del
  servidor (fotos/selfies subidas).

### En cPanel

1. File Manager → carpeta de la app → subir ZIP → **Extraer** (sobrescribe
   `dist/` y `node_modules/`, deja `uploads/` y `.env` intactos).
2. Asegurar **Node 20+** en *Setup Node.js App* y que el startup sea
   `node dist/server.js` (o `npm start`).
3. **Reiniciar** la app (botón Restart de Setup Node.js App).
4. **phpPgAdmin** → base de datos del backend → pestaña SQL → pegar todo el
   contenido de **`deploy_cpanel.sql`** → Executar.

### Orden importa

1. Subir código + restart → la API nueva puede arrancar aunque la BD esté vieja
   (los endpoints nuevos solo fallarían al usar `checkpoint`).
2. Correr `deploy_cpanel.sql` en phpPgAdmin.
3. Verificar (paso 4).

> Si preferís primero la BD y después el código, también funciona — el SQL es
> aditivo, al código viejo no le molesta.

---

## 3. El SQL: qué pasa si algo falla

- **Sección (0) DIAGNÓSTICO**: los conteos valen **1 = ya existe**; si algún
  `falta_modalidad`/`falta_user_epi_id` da **0** = falta esa parte, y
  `epi_con_poligono` debe dar 5. El **chequeo de turnos** (2º SELECT de esa
  sección) debe dar **0**: si da >0 hay turnos finalizados sin
  `lat_fin/lng_fin` y el CHECK no se puede crear (el propio archivo trae el
  fix `NOT VALID` comentado).
- Todo el archivo corre como **una transacción**: si falla, **no se aplica
  nada** (no queda a medias). Arreglás y volvés a pegar el mismo archivo.
- Idempotente: re-ejecutarlo no duplica triggers/índices/tablas.
- Prefijos duplicados (`0002_*`, `0003_*`) no afectan: no se usa la CLI de
  Prisma, solo el SQL mergeado.

---

## 4. Verificación post-deploy

```bash
curl https://<tu-api>/api/health        # → ok
```

El propio `deploy_cpanel.sql` termina con un SELECT que debe dar
`1, 1, 5, 1, 1, 2, true` (modalidad, epi_id, polígonos, check, enum, triggers,
tabla checkpoint).

**Asignar la EPI a tu cuenta** (si no, el mapa muestra *"Tu cuenta no tiene una
EPI asignada"*): al final del archivo hay un `UPDATE "user" SET epi_id = ...`
de ejemplo — descomentalo con tu email.

En la app: login OK · **mapa carga sin el error de jurisdicción** · hecho
muestra dirección · subir foto funciona · realtime conecta.

---

## 5. Variables de entorno (`.env` del servidor)

| Var | Valor producción |
|---|---|
| `DATABASE_URL` | Postgres del cPanel |
| `NODE_ENV` | `production` |
| `PORT` | el que asigna cPanel |
| `COOKIE_SECURE` | `true` |
| `CORS_ORIGINS` | `https://<frontend>.vercel.app` (sin `/`, dominio exacto) |
| `JWT_SECRET` | idéntico al del frontend (si no, el front rechaza todas las sesiones) |
| `DEV_RETURN_RESET_CODE` | `false` |

Si el server no arranca y loguea `Configuración de entorno inválida`, revisá
estos valores (falla temprano a propósito).

---

## 6. Rollback

- **Código**: subir el ZIP de la versión anterior + restart.
- **SQL**: no se revierte (aditivo). Solo si algo se rompió → restaurar backup
  de la BD desde cPanel (hacé uno antes de cada deploy:
  phpPgAdmin → Export, o cPanel → Backup de BD).

---

## 7. Trampas conocidas

- **`uploads/` no está en git** y no está en el ZIP: si tu forma de desplegar
  borra la carpeta de la app, esas fotos se pierden. Extraer ZIP **no** borra
  archivos que no están en él → `uploads/` sobrevive. Igual, backup ocasional.
- **`node_modules` subido desde Windows funciona** porque `schema.prisma` ya
  tiene `binaryTargets` con debian/rhel; pero **siempre** regeneralo en tu PC
  con `npx prisma generate` después de `git pull`, si no el cliente no conoce
  los modelos nuevos (`Checkpoint`).
- **`npm run build` se hace en tu PC**, no en el servidor (no hay terminal).
  Subí siempre `dist/` recién generado.
- **Multer**: si al subir foto da 500, revisá que `node_modules/multer/`
  exista en el servidor (se instaló con `npm install` de este deploy).
- **WebSocket**: si el proxy de cPanel no permite el upgrade, Socket.io cae a
  *long-polling* solo (funciona, es más lento).
- **PostgreSQL viejo (< 11) en cPanel**: `CREATE TRIGGER ... EXECUTE FUNCTION`
  da *syntax error at or near "function"*. El archivo ya usa `EXECUTE
  PROCEDURE` (aceptado en todas las versiones) — si revertís ese cambio, vuelve
  el error.
- **Error "No se pudo cargar la jurisdicción por EPI..."** en el mapa:
  1) backend viejo sin `GET /api/mapas/jurisdiccion` → falta subir el código
     nuevo; 2) falta correr `deploy_cpanel.sql` (partes 3–4: `epi_id` y
     polígonos); 3) tu cuenta no tiene `epi_id` → mensaje de "sin EPI
     asignada" (ver §4). Después de correr el SQL, si el endpoint sigue en
     404 reiniciá la app (cache de módulos de Node).
