# 02 · Referencia de la API

> **Base URL:** `https://<host>/api` (local: `http://localhost:4000/api`)
> **Formato:** JSON UTF-8 · respuestas comprimidas (gzip) · tamaño máximo de cuerpo **1 MB** (excepto `/api/media`, 25 MB multipart).
> **Audiencia:** equipos de frontend web, app móvil y QA.

---

## Índice

1. [Convenciones](#1-convenciones)
2. [Autenticación web — `/auth`](#2-autenticación-web--auth)
3. [Autenticación móvil — `/mobile/auth`](#3-autenticación-móvil--mobileauth)
4. [Usuarios — `/usuarios`](#4-usuarios--usuarios)
5. [Guardias — `/guardias`](#5-guardias--guardias)
6. [Hechos — `/hechos`](#6-hechos--hechos)
7. [Mapas, rutas y ejecuciones — `/mapas`](#7-mapas-rutas-y-ejecuciones--mapas)
8. [Programación de rutas — `/programaciones`](#8-programación-de-rutas--programaciones)
9. [Puntos fijos — `/puntos-fijos`](#9-puntos-fijos--puntos-fijos)
10. [EPIs — `/epis`](#10-epis--epis)
11. [Dashboard — `/dashboard`](#11-dashboard--dashboard)
12. [Auditoría — `/auditoria`](#12-auditoría--auditoria)
13. [Endpoints de la app móvil](#13-endpoints-de-la-app-móvil)
14. [Salud](#14-salud)
15. [Catálogo de errores](#15-catálogo-de-errores)

---

## 1. Convenciones

### 1.1 Envoltorio de respuesta

Toda respuesta exitosa tiene la forma:

```json
{ "data": <recurso | lista | objeto>, "meta": { "total": 120, "page": 1, "pageSize": 20 } }
```

`meta` solo aparece en listados paginados o exportaciones. Toda respuesta de error tiene la forma:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Datos de entrada inválidos.",
             "details": [ { "path": "guardias.0.guardiaId", "message": "Invalid uuid" } ] } }
```

### 1.2 Autenticación y columnas de las tablas

| Columna | Significado |
|---|---|
| **Auth** | `Pública` · `Web` (cookie `gamc_access`) · `Guardia` (Bearer con `tipo = guardia`, `requireGuardia`) · `Cualquiera` (web o móvil autenticado) |
| **Permiso** | `recurso:acción` exigido por `authorize()` antes de entrar al handler. `servicio` = el permiso se valida dentro del caso de uso (normalmente porque depende del tipo de recurso). |
| **EPI** | ✔ = la respuesta o la escritura está limitada a la jurisdicción del usuario (Super Admin: global). Ver [03 · Seguridad §5](03-seguridad.md#5-jurisdicción-territorial-epi). |

### 1.3 Mutaciones desde la web

Las mutaciones de `/auth` (`logout`, `change-password`) exigen el header **`x-csrf-token`** con el valor de la cookie `gamc_xsrf`. Las solicitudes con `Authorization: Bearer` están exentas.

### 1.4 Tipos comunes

| Tipo | Formato | Ejemplo |
|---|---|---|
| `uuid` | UUID v4 | `"7d1e…"` |
| `lngLat` | `[lng, lat]` (orden GeoJSON) | `[-66.1569, -17.3935]` |
| `fecha` | `AAAA-MM-DD` (día local Bolivia) | `"2026-10-18"` |
| `instante` | ISO-8601 | `"2026-10-18T14:05:00.000Z"` |
| `hora` | `HH:MM` 24 h | `"07:30"` |
| `modalidad` | `coche` \| `moto` \| `a_pie` \| `punto_fijo` \| `oficina` | |
| `nivelRiesgo` | `bajo` \| `medio` \| `alto` \| `muy_alto` | |

### 1.5 Paginación

Los listados que la admiten aceptan `page` (≥ 1) y `pageSize` (1–100, por defecto 20) y devuelven `meta.total`. `/hechos` también admite el estilo `limit`/`offset`.

---

## 2. Autenticación web — `/auth`

| Método | Ruta | Auth | Límite | Descripción |
|---|---|---|---|---|
| POST | `/auth/login` | Pública | 5 / 30 s (fallidos) | Inicia sesión; emite las cookies de sesión |
| POST | `/auth/refresh` | Cookie `gamc_refresh` | — | Rota acceso y refresh |
| POST | `/auth/logout` | CSRF | — | Revoca el refresh y borra cookies |
| GET | `/auth/me` | Web | — | Principal autenticado |
| POST | `/auth/recovery/request` | Pública | 10 / 15 min | Solicita código de 6 dígitos |
| POST | `/auth/recovery/confirm` | Pública | 10 / 15 min | Confirma código y fija nueva contraseña |
| POST | `/auth/change-password` | Web + CSRF | — | Cambio de contraseña autenticado |
| POST | `/auth/activar` | Pública | 5 / 30 s | Activación de guardia (alias del endpoint móvil) |

### `POST /auth/login`

```json
// Request
{ "identifier": "maria.rojas@cochabamba.bo", "password": "SuperAdmin#2025" }

// 200 OK  (+ Set-Cookie: gamc_access, gamc_refresh, gamc_profile, gamc_xsrf)
{ "data": { "principal": { "id": "…", "identifier": "maria.rojas", "name": "María Rojas",
                           "role": "super_admin", "debeCambiarPassword": false } } }
```

`identifier` acepta correo o nombre de usuario (3–120 caracteres). Si el cuerpo incluye `"tipo": "guardia"`, el endpoint se comporta como `/mobile/auth/login` (compatibilidad).

Errores: `401 INVALID_CREDENTIALS`, `403 ACCOUNT_DISABLED`, `429 RATE_LIMITED`.

### `POST /auth/recovery/request`

```json
{ "identifier": "carlos.mendoza@cochabamba.bo" }
// 200 → { "data": { "accepted": true, "expiresAt": "…", "devCode": "482913" } }
```

La respuesta es idéntica exista o no la cuenta (anti-enumeración). `devCode` solo aparece con `DEV_RETURN_RESET_CODE=true` y fuera de producción.

### `POST /auth/recovery/confirm` · `POST /auth/change-password`

```json
{ "identifier": "…", "code": "482913", "newPassword": "Nueva#Clave2026" }
{ "currentPassword": "…", "newPassword": "Nueva#Clave2026" }
```

**Política de contraseña:** 8–72 caracteres con al menos una minúscula, una mayúscula, un número y un símbolo.

---

## 3. Autenticación móvil — `/mobile/auth`

Espejo de `/auth` para la app de guardias. **Los tokens viajan siempre en el cuerpo JSON, nunca en cookies.**

| Método | Ruta | Auth | Body | Respuesta `data` |
|---|---|---|---|---|
| POST | `/mobile/auth/login` | Pública (5/30 s) | `{ usuario, password }` | `{ accessToken, refreshToken, guardia }` |
| POST | `/mobile/auth/activar` | Pública (5/30 s) | `{ usuario, activacion_token, password }` | Igual que login |
| POST | `/mobile/auth/refresh` | Pública | `{ refreshToken }` | Nuevo par de tokens |
| POST | `/mobile/auth/logout` | Pública | `{ refreshToken? }` | `{ ok: true }` |
| GET | `/mobile/auth/me` | Guardia | — | `{ guardia }` |

> ⚠️ **Compatibilidad con APK publicado:** en este router `INVALID_CREDENTIALS` responde **`400`** (no `401`) porque la app instalada interpreta cualquier `401` como "sesión expirada". No cambiar sin coordinar una nueva versión de la app.

`activacion_token` también se acepta como `activacionToken`. Una cuenta `pendiente_activacion` se activa automáticamente en el primer login exitoso con la contraseña temporal.

---

## 4. Usuarios — `/usuarios`

| Método | Ruta | Auth | Permiso | Descripción |
|---|---|---|---|---|
| GET | `/usuarios/roles` | Web | `usuarios:ver` | Catálogo de roles |
| GET | `/usuarios` | Web | `usuarios:ver` | Lista de cuentas del personal |
| POST | `/usuarios` | Web | `usuarios:crear` | Crea cuenta; responde `201` con credenciales temporales |
| PATCH | `/usuarios/:id` | Web | `usuarios:editar` (+ `jurisdiccion_usuarios:editar` si cambia `epiCodigo`) | Edita datos |
| PATCH | `/usuarios/:id/estado` | Web | `usuarios:editar` | `{ estado: activo \| inactivo \| suspendido }` |

**Body de creación**

```json
{
  "rol": "operador_monitoreo",
  "primerNombre": "Ana", "segundoNombre": null,
  "apellidoPaterno": "Flores", "apellidoMaterno": "Rocha",
  "email": "ana.flores@cochabamba.bo", "usuario": "ana.flores",
  "ci": "7654321", "telefono": "70000000",
  "epiCodigo": "central"
}
```

Cambiar la EPI de una cuenta queda auditado (`cambiar_epi_usuario`) y **cierra sus conexiones WebSocket** para que reconecte con las salas correctas.

---

## 5. Guardias — `/guardias`

| Método | Ruta | Permiso | EPI | Descripción |
|---|---|---|---|---|
| GET | `/guardias` | `guardias:ver` | ✔ | Lista paginada con última posición |
| GET | `/guardias/:id` | `guardias:ver` | ✔ | Detalle |
| POST | `/guardias` | `guardias:crear` | | Alta; genera usuario y contraseña temporal |
| PATCH | `/guardias/:id` | `guardias:editar` | | Edita ficha |
| PATCH | `/guardias/:id/estado` | `guardias:editar` | | Estado de cuenta: `activo` \| `inactivo` \| `suspendido` |
| PATCH | `/guardias/:id/estado-operativo` | `guardias:editar` | | `fuera_de_servicio` \| `en_servicio` \| `emergencia` |
| POST | `/guardias/:id/sos/atender` | `sos:editar` | | Atiende alertas SOS: `{ alertaIds?: string[] }` (máx. 100) |

**Filtros de `GET /guardias`:** `q`, `epi` (o `epiCodigo`), `epiActual` (EPI según su GPS), `estado`, `estadoOperativo`, `excluirInactivos=1`, `page`, `pageSize`.

**Alta:** `fechaNacimiento` en formato **`DD/MM/AAAA`**.

**Atención de SOS:** se atienden *exactamente* las alertas indicadas en `alertaIds` (las que el operador vio). Sin `alertaIds`, se atienden todas las abiertas. Un SOS nuevo que llegue después no se cierra con esa confirmación.

---

## 6. Hechos — `/hechos`

| Método | Ruta | Auth | Permiso | EPI | Descripción |
|---|---|---|---|---|---|
| GET | `/hechos/tipos` | Cualquiera | `hechos:ver` (web) | | Catálogo de tipos de hecho |
| POST | `/hechos` | Guardia | — | | Alta desde la app |
| GET | `/hechos` | Cualquiera | `hechos:ver` (web) | ✔ | Web: bandeja filtrada · Guardia: solo su historial |
| GET | `/hechos/exportar` | Web | `hechos:ver` | ✔ | Exportación completa (todas las páginas) |
| GET | `/hechos/:id` | Web | `hechos:ver` | ✔ | Detalle con evidencias |
| PATCH | `/hechos/:id/estado` | Web | `hechos:editar` | ✔ | `{ estado: reportado \| en_revision \| cerrado }` |
| PATCH | `/hechos/:id/epi` | Web | `hechos:editar` + alcance global | | Reclasifica la EPI: `{ epiCodigo }` |

**Filtros:** `q`, `tipo`, `estado`, `epiId` (o `epi`), `nivelRiesgo`, `desde`, `hasta`, `clasificacion`; paginación `page`/`pageSize` (con `meta.total`) o `limit`/`offset`.

**Alta móvil**

```json
{
  "tipoCodigo": "hurto",
  "descripcion": "Sustracción de mochila en parada de transporte.",
  "nivelRiesgo": "medio",
  "lat": -17.3925, "lng": -66.1425,
  "ocurridoEn": "2026-10-18T13:40:00Z",
  "direccion": "Terminal de Buses",
  "turnoId": "…",
  "evidencias": [ { "url": "https://<host>/media/2f…jpg", "tipo": "foto" } ]
}
```

Se acepta `tipoHechoId` o `tipoCodigo`; máximo 12 evidencias. La EPI del hecho se calcula a partir de su ubicación. Las URLs de evidencia deben obtenerse antes con `POST /media`.

`/exportar` devuelve `meta.truncado = true` si se alcanzó el tope interno de filas.

---

## 7. Mapas, rutas y ejecuciones — `/mapas`

Todas las rutas requieren sesión web.

### 7.1 Lectura

| Método | Ruta | Permiso | EPI | Descripción |
|---|---|---|---|---|
| GET | `/mapas/ubicaciones` | `mapas:ver` | parcial | Posición actual de **todos** los guardias (disponibilidad global); el nombre de la ruta solo se muestra dentro del alcance |
| GET | `/mapas/patrullas` | `mapas:ver` | ✔ | Patrullas vigentes |
| GET | `/mapas/jurisdiccion` | `mapas:ver` | | `{ epis: [polígono, color], miEpiCodigo, restringido }` |
| GET | `/mapas/rutas` | `mapas:ver` | ✔ | Biblioteca de rutas |
| GET | `/mapas/zonas` | `mapas:ver` | ✔ | Zonas críticas activas |
| GET | `/mapas/heatmap?desde&hasta&epiId` | `mapas:ver` | ✔ | Mapa de calor de hechos |
| GET | `/mapas/recorrido?turnoId \| guardiaId&desde&hasta` | `mapas:ver` | ✔ | Recorrido GPS real; fuera del alcance global se recorta a los tramos de rutas de la EPI |
| POST | `/mapas/geocodificar` | `mapas:ver` | | Geocodificación inversa de 1–6 puntos `{ puntos: [{ lat, lng }] }` |

### 7.2 Biblioteca de rutas

| Método | Ruta | Permiso | Descripción |
|---|---|---|---|
| POST | `/mapas/rutas` | servicio (`rutas_establecidas` o `patrullaje` según `tipo`) | Crea ruta sin asignarla |
| PATCH | `/mapas/rutas/:id` | servicio | Edita nombre, descripción, tipo, modalidad |
| PATCH | `/mapas/rutas/:id/archivar` | servicio | Borrado lógico; las ejecuciones en curso continúan |
| PATCH | `/mapas/rutas/:id/cancelar` | `patrullaje:editar` | *Legado:* cancela todas las ejecuciones vigentes de la plantilla |

```json
// POST /mapas/rutas
{
  "nombre": "Circuito Plaza 14 de Septiembre",
  "descripcion": "Recorrido nocturno",
  "trazado": [[-66.1569, -17.3935], [-66.1561, -17.3929], …],
  "modalidad": "a_pie",
  "tipo": "establecida"
}
```

El `trazado` (2–2000 vértices `lngLat`) ya llega ruteado por calles desde la web (OSRM). **El trazado completo debe quedar dentro de la EPI del usuario** (tolerancia de borde: 60 m).

### 7.3 Motor de asignación

| Método | Ruta | Permiso | Descripción |
|---|---|---|---|
| POST | `/mapas/ejecuciones/previsualizar` | `patrullaje:crear` | Conflictos y avisos de GPS **sin escribir** |
| POST | `/mapas/ejecuciones` | `patrullaje:crear` | Asigna una ruta a un grupo de guardias |
| PATCH | `/mapas/ejecuciones/:id/cancelar` | `patrullaje:editar` | Cancela **una** ejecución |
| PATCH | `/mapas/patrullas/:id/cancelar` | `patrullaje:editar` | Retira a **un** guardia: `{ reposicion?: automatica \| manual }` |
| POST | `/mapas/patrullas` | `patrullaje:crear` | *Legado:* asignación individual (delega al mismo motor) |
| POST | `/mapas/zonas/recalcular` | `patrullaje:crear` | Recalcula zonas críticas |

**`POST /mapas/ejecuciones`**

```json
{
  "claveIdempotencia": "3b0b6c1e-6a52-4e7e-9a0c-8f8a7c1a2d11",
  "rutaPlantillaId": "…",
  "modalidad": "coche",
  "unidad": "Móvil 12",
  "guardias": [ { "guardiaId": "…" }, { "guardiaId": "…" } ],
  "confirmaciones": [ { "guardiaId": "…", "patrullaId": "…" } ]
}
```

Reglas del cuerpo:

- Exactamente **un origen**: `rutaPlantillaId`, `nueva` (`{ nombre, trazado, tipo }`) o `puntoFijoId` — salvo que se envíe `ejecucionId` para sumar guardias a una ejecución existente (p. ej. un horario programado abierto).
- `guardias`: 1–50. En puntos fijos, cada guardia puede indicar `puntoFijoId` (subpunto) o `punto`.
- `confirmaciones`: consentimiento explícito para retirar a un guardia de su ruta actual. Sin él, la operación se rechaza con `409`.

**Respuesta `201`**

```json
{ "data": { "ejecucion": { "id": "…", "estado": "activa", "capacidad": 12, … },
            "patrullaIds": ["…", "…"],
            "noAsignados": [ { "guardiaId": "…", "motivo": "…" } ] } }
```

La asignación es **parcial**: se asigna a los aptos y se informa el resto en `noAsignados`. Reenviar la misma `claveIdempotencia` devuelve el resultado original.

---

## 8. Programación de rutas — `/programaciones`

| Método | Ruta | Permiso | EPI | Descripción |
|---|---|---|---|---|
| GET | `/programaciones?incluirArchivadas=1` | `programacion_rutas:ver` | ✔ | Lista de programaciones |
| GET | `/programaciones/agenda?desde&hasta` | `programacion_rutas:ver` | ✔ | Horarios entre dos fechas (por defecto hoy y mañana; máx. 14 días) |
| GET | `/programaciones/pendientes` | `programacion_rutas:ver` | ✔ | Horarios abiertos con cupo sin cubrir (campana) |
| GET | `/programaciones/horarios/:ejecucionId/automatica` | `programacion_rutas:ver` | ✔ | Intentos de asignación automática: elegidos, descartados y motivo |
| POST | `/programaciones/horarios/:ejecucionId/reanudar` | servicio | ✔ | Reanuda la automática tras una elección manual |
| GET | `/programaciones/planificador` | `programacion_rutas:ver` | | Estado del planificador |
| PATCH | `/programaciones/planificador` | servicio (solo Super Admin) | | `{ habilitado, motivo? }` — pausa la **apertura** de horarios |
| POST | `/programaciones` | servicio (`programacion_rutas:crear`) | ✔ | Crea programación |
| PATCH | `/programaciones/:id` | servicio (`programacion_rutas:editar`) | ✔ | Edita / pausa |
| DELETE | `/programaciones/:id` | servicio (`programacion_rutas:eliminar`) | ✔ | Borrado lógico; cancela el horario abierto y conserva historial |

```json
// POST /programaciones
{
  "nombre": "Plaza Principal — mañana",
  "puntoFijoId": "…",
  "modo": "automatica",
  "ventanas": [
    { "dias": [1, 2, 3, 4, 5], "horaInicio": "07:00", "duracionMin": 480, "cupo": 2 }
  ]
}
```

- Origen: `rutaPlantillaId` **o** `puntoFijoId`.
- `dias`: ISO, 1 = lunes … 7 = domingo. `duracionMin`: 15–1440. `cupo`: 1–50. Hasta 14 ventanas.
- `modo`: `manual` (los operadores asignan) o `automatica` (el sistema asigna a los guardias libres más cercanos).
- Para asignar guardias manualmente a un horario abierto se usa `POST /mapas/ejecuciones` con `ejecucionId`.

---

## 9. Puntos fijos — `/puntos-fijos`

| Método | Ruta | Permiso | EPI | Descripción |
|---|---|---|---|---|
| GET | `/puntos-fijos?incluirInactivos=1&epi=` | `mapas:ver` | ✔ | Catálogo con ocupación |
| GET | `/puntos-fijos/:id/historial` | `puntos_fijos:ver` | ✔ | Versiones del punto |
| POST | `/puntos-fijos` | servicio (`puntos_fijos:crear`) | ✔ | Alta de punto o subpunto (`padreId`) |
| PATCH | `/puntos-fijos/:id` | servicio (`puntos_fijos:editar`) | ✔ | Edición; `politicaOcupados: trasladar \| retirar` al mover o desactivar |

`capacidad`: 1–50. Un subpunto debe estar a ≤ 1500 m de su punto. La capacidad de un punto con subpuntos es la suma de sus subpuntos activos.

---

## 10. EPIs — `/epis`

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/epis` | Cualquiera | Catálogo de EPIs vigentes: sede, teléfonos, territorio |
| GET | `/epis/modulos` | Cualquiera | Módulos policiales |

---

## 11. Dashboard — `/dashboard`

Requiere `dashboard:ver` (Super Admin y Admin). Todos los datos se limitan a la EPI del usuario.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/dashboard/kpi` | KPIs agregados |
| GET | `/dashboard/series/deficit?dias=N` | Hechos por día (N: 1–30, por defecto 7) |
| GET | `/dashboard/series/por-tipo` | Hechos por tipo |
| GET | `/dashboard/series/por-zona` | Hechos por zona |

---

## 12. Auditoría — `/auditoria`

| Método | Ruta | Permiso | Descripción |
|---|---|---|---|
| GET | `/auditoria?page&limit&accion&recurso` | `auditoria:ver` | Bitácora paginada (`limit` 1–100, por defecto 20) |

---

## 13. Endpoints de la app móvil

Todos con `Authorization: Bearer <accessToken>` de guardia. El `guardiaId` **siempre** sale del JWT; nunca del cuerpo.

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/media` | Sube un archivo a Cloudflare R2 (`multipart/form-data`, campo `file`, máx. 25 MB) → `{ url, tipo: foto \| video }` |
| POST | `/turnos` | Inicia turno: `{ selfieInicioUrl, lat, lng, horaInicio?, patrullaId? }` |
| PATCH | `/turnos/:id/cerrar` | Cierra turno: `{ lat?, lng?, horaFin? }` |
| GET | `/turnos?limit=50` | Historial de turnos propios |
| GET | `/turnos/:id/recorrido` | Recorrido GPS del turno (también web con `mapas:ver`) |
| POST | `/telemetry` | Ping GPS / SOS (ver abajo) |
| GET | `/telemetry/estado` | Estado del último SOS propio y estado operativo |
| GET | `/patrullas/vigente` | Patrulla asignada vigente |
| POST | `/mandados` · GET `/mandados` | Registrar / listar tareas propias |
| GET | `/mandados/todos?limit&desde&guardiaId` | *Web* (`hechos:ver`, EPI ✔): mandados recientes |
| POST | `/checkpoints` · GET `/checkpoints` | Registrar / listar marcas fotográficas |
| POST | `/hechos` · GET `/hechos` | Registrar / listar hechos propios |

**`POST /telemetry`**

```json
{
  "lat": -17.3935, "lng": -66.1569,
  "precisionM": 12, "velocidadMps": 1.1, "bateriaPct": 64,
  "turnoId": "…",
  "esSos": false,
  "capturadoEn": "2026-10-18T14:05:00Z"
}
```

Se rechaza si `capturadoEn` está adelantado más de **5 minutos** respecto al servidor o si `turnoId` no pertenece al guardia. Un SOS es este mismo ping con `"esSos": true`.

**Flujo de subida de evidencia:** `POST /media` → usar la `url` devuelta en `POST /turnos` (`selfieInicioUrl`) o `POST /hechos` (`evidencias[].url`). Formatos admitidos: JPEG, PNG, WebP, MP4 y MOV. El servidor genera el nombre (UUID) y guarda el archivo en el bucket de R2 (`fotos/…` o `videos/…`); la URL devuelta es la definitiva y la web la muestra directamente.

---

## 14. Salud

| Método | Ruta | Auth | Respuesta |
|---|---|---|---|
| GET | `/health` y `/api/health` | Pública | `{ "data": { "ok": true, "uptimeSeconds": 1234 } }` |

---

## 15. Catálogo de errores

| HTTP | `code` | Cuándo |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Cuerpo/consulta inválidos; `details` es una lista `{ path, message }` por campo |
| 400 | `ACTIVATION_INVALID` | Usuario o token de activación inválido/expirado |
| 400 | `RESET_CODE_INVALID` / `RESET_CODE_EXPIRED` | Código de recuperación incorrecto o vencido |
| 400 | `INVALID_CREDENTIALS` | *Solo en `/mobile/auth`* (ver §3) |
| 401 | `UNAUTHORIZED` | Sin token, token inválido/expirado o refresh reutilizado |
| 401 | `INVALID_CREDENTIALS` | Usuario o contraseña incorrectos (web) |
| 403 | `FORBIDDEN` | Sin permiso, fuera de la EPI, CSRF inválido o endpoint exclusivo de guardias |
| 403 | `ACCOUNT_DISABLED` | Cuenta `inactivo` o `suspendido` |
| 404 | `NOT_FOUND` | Recurso o ruta inexistente |
| 409 | `CONFLICT` | Choque con el estado actual (capacidad, reasignación sin confirmar, etc.) |
| 409 | `GUARDIA_PENDING_ACTIVATION` | Cuenta de guardia pendiente de activación |
| 429 | `RATE_LIMITED` | Límite de intentos superado; incluye `Retry-After` y headers `RateLimit` (draft-7) |
| 500 | `INTERNAL_ERROR` | Error no controlado (registrado en el log) |

**Recomendación para clientes:** ramificar por `error.code`, no por el texto de `message` (que está pensado para mostrarse al usuario y puede cambiar).
