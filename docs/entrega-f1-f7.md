# Entrega F1–F7: EPIs, patrullaje, puntos fijos y programación

Backend y base de datos. Requiere las migraciones 0001–0005. La web
compatible es la entrega F1–F7 del frontend (`manual/Entrega-F1-F7.md`).

## Qué incluye

| Fase | Migración | Resumen |
|---|---|---|
| F1 | `0006_epi_catalogo_inventario` | Catálogo de 6 EPIs del inventario oficial: datos de sede, territorios versionados (`epi_territorio`) y módulos policiales (`modulo_policial`). Nuevas EPIs Jaihuayco y Alalay Sud. `GET /api/epis` y `GET /api/epis/modulos`. La jurisdicción se lee del territorio vigente y se rechaza si la EPI del usuario está inactiva. El trazado completo de una ruta debe quedar dentro de la EPI. |
| F2 | `0007_ruta_ejecucion` | Cada asignación es una ejecución con copia del trazado, capacidad por modalidad y ventana de vigencia. Motor transaccional con asignación parcial, reasignación confirmada e idempotencia. Estado respecto a la ruta calculado en cada ping. Cierre automático de rutas vencidas. SOS con permiso propio. Una sola asignación activa por guardia. |
| F3 | `0008_segmentacion_epi` | Segmentación de lectura y escritura por EPI; EPI actual del guardia según su GPS (`guardia_ubicacion_actual`); guardias libres de cualquier EPI; EPI de hechos y mandados por su ubicación; exportación completa; eventos en vivo por EPI. |
| F4 | `0009_puntos_fijos` | Catálogo de puntos fijos y subpuntos con capacidad, asignación por identidad del punto y ocupación. |
| F5 | `0010_programacion_rutas` | Programación de rutas por días y horas. El planificador del servidor (cada minuto) abre cada horario 15 min antes, lo inicia y lo cierra con su cobertura. |
| F6 | `0011_asignacion_automatica` | Asignación automática de horarios: guardias libres más cercanos con GPS válido, radio de 3 km que crece 2 km cada 3 min (tope 20 km); retiro con reposición. |
| F7 | `0012_plazo_incorporacion` | Plazo para incorporarse a la ruta: vencido sin llegar, el guardia pasa a advertencia o alerta según su distancia. |

Todas las migraciones son aditivas e idempotentes, con precondiciones y
verificación propias. Excepciones aprobadas, todas con reversión:

- **0006** desactiva `centro_cercado` (no figura en el inventario oficial) y
  aplica los nombres oficiales («EPI Sud» → «EPI Sur»; el código `sud` se
  conserva).
- **0007** crea un índice único de una asignación activa por guardia. Si ya
  hay duplicados, aborta y los lista sin corregirlos. Además, `v_patrulla_vigente`
  mantiene sus columnas pero corrige la vigencia.
- **0008** reclasifica `hecho.epi_id` y `mandado.epi_id` por su ubicación, con
  los valores anteriores en `hecho_epi_reclasificacion`. Al Operador se le
  quita `guardias.editar`, porque el SOS tiene su propio permiso `sos`; el valor
  anterior queda en `permiso_cambio_registro`.

## Despliegue

1. **Respaldar la base** (`pg_dump -Fc`).
2. **Aplicar la base de datos**, elegir UNA opción:
   - Con Prisma (la base tiene `_prisma_migrations`):
     `npx prisma migrate deploy`
   - Con SQL (Supabase u otro servidor sin Prisma), desde la raíz del backend:
     `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f scripts/sql/entrega_f1_f7.sql`
     (una sola transacción: si algo falla, no queda nada aplicado).
3. `npm ci` (incluye `prisma generate`), `npm run build` y `npm start`.
4. Publicar la web compatible **después** del backend.

No hay variables de entorno nuevas obligatorias. `DESACTIVAR_VENCIMIENTO_RUTAS=1`
apaga el planificador del servidor (cierres, horarios programados y plazos de
incorporación). Solo se usa para mantenimiento; en producción no debe
definirse. Varias instancias pueden correr el planificador a la vez: cada
paso usa bloqueos de la base.

## Verificación tras desplegar

- `GET /api/health` responde `ok`.
- `GET /api/epis` devuelve las EPIs vigentes; `GET /api/mapas/patrullas` y
  `GET /api/mapas/ubicaciones` responden con sesión de Super Admin.
- En la web: asignar una ruta a un guardia en servicio. Aparece
  «Incorporándose» con su plazo y pasa a «En ruta» al llegar.
- Programar un horario de prueba: aparece en la agenda 15 min antes y la
  campana avisa si faltan guardias.
- La tabla `planificador_estado` actualiza `ultima_pasada` cada minuto.

## Reversión

Volver a publicar primero el backend y la web anteriores. Después:

`psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/revert/entrega_f1_f7.revert.sql`

Revierte de 0012 a 0006. Se detiene, sin cambiar nada, si hay horarios
abiertos, programaciones automáticas o guardias en puntos fijos: el mensaje
indica qué cancelar desde la web antes de reintentar. También se puede
revertir una sola migración con su archivo en `scripts/sql/revert/`.

No ejecutar el seed de demostración en producción.
