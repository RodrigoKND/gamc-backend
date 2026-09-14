# Scripts SQL — Datos Simulados GAMC

Estos scripts **no son mock dentro del proyecto** — son SQL puro para ejecutar directo en PostgreSQL. Poblan la misma BD que usan web y app movil.

## Requisitos
- BD creada con `prisma/migrations/0001_init/migration.sql`
- Seed base ejecutado: `npm run db:seed` dentro de `gamc-api` (crea roles, EPIs, 3 usuarios, 2 guardias)

## Ejecucion (elige una)

### A) Todo de una vez (recomendado)
```bash
# Desde gamc-api, con DATABASE_URL en .env
psql "$DATABASE_URL" -f scripts/sql/00_datos_simulados_MASTER.sql

# O con credenciales explicitas
psql -U postgres -h localhost -d gamc_seguridad -f scripts/sql/00_datos_simulados_MASTER.sql
```

### B) Paso a paso
```bash
psql "$DATABASE_URL" -f scripts/sql/01_guardias_simulados.sql
psql "$DATABASE_URL" -f scripts/sql/02_rutas_plantilla.sql
psql "$DATABASE_URL" -f scripts/sql/03_turnos_y_telemetria.sql
psql "$DATABASE_URL" -f scripts/sql/04_hechos_simulados.sql
psql "$DATABASE_URL" -f scripts/sql/05_patrullas_y_zonas.sql
```

### C) Verificar que el frontend vera datos
```bash
psql "$DATABASE_URL" -f scripts/sql/99_verificacion.sql
```

## Que inserta cada script

| Script | Inserta | Idempotente |
|--------|---------|-------------|
| `01_guardias_simulados.sql` | 18 guardias (ci 8000100-8000117) con estado operativo mixto (en_servicio/emergencia/fuera_de_servicio), hash `Guardia#2025` | Si (ON CONFLICT ci) |
| `02_rutas_plantilla.sql` | 15 rutas (3 por EPI) con poligono GeoJSON valido | Si (IF NOT EXISTS nombre) |
| `03_turnos_y_telemetria.sql` | 1 turno `en_servicio` por guardia activo + 3 puntos GPS con `bateria_pct` (incluye 2 con bateria baja 12%/18%), SOS si emergencia | Si (skip si ya tiene turno/telemetria) |
| `04_hechos_simulados.sql` | 30 hechos ultimos 7 dias, todos los niveles/estados/EPIs, con evidencia foto | No (cada ejecucion crea 30 nuevos) |
| `05_patrullas_y_zonas.sql` | 6 patrullas vigentes (hoy) + recalculo `zona_critica_activa` por EPI | Zona: si (invalida vigentes y recalcula) |

## Notas
- Password de todos los guardias simulados: `Guardia#2025` (hash bcrypt $2a$12$...)
- Coordenadas centradas en Cochabamba (-17.3935, -66.1653) con jitter para cada EPI
- Bateria baja forzada en `ci 7564321` (12%) y `ci 8123456` (18%) para probar alertas en UI y endpoint `/api/mapas/ubicaciones`
- Los scripts usan `gen_random_uuid()` (ext pgcrypto) y `random()` — no requieren PostGIS
- Para limpiar datos de prueba sin borrar base: `TRUNCATE hecho, guardia_telemetria, turno, patrulla, zona_critica_activa, ruta_plantilla CASCADE;` luego re-ejecutar

## Compatibilidad movil
Los mismos endpoints que consume el frontend consumiran la app movil:
- `GET /api/mapas/ubicaciones` ya incluye `bateriaPct`
- `GET /api/mapas/heatmap?desde=&hasta=&epiId=` para mapa de calor
- `POST /api/mapas/patrullas` y `POST /api/mapas/rutas` para asignar/plantillas
- Socket.io ahora acepta `Authorization: Bearer <jwt>` ademas de cookie, para que el movil reciba `guardia:ubicacion`/`sos:nuevo` en tiempo real
