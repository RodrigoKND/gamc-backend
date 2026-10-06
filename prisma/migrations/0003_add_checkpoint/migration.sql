-- Verificación periódica de ronda (selfie + GPS) — BD_UNIFICADA no la incluía
-- porque la app todavía no tenía backend para esto (stub local en el móvil).
-- Escrita a mano (no generada con `prisma migrate diff`) porque el historial
-- de migraciones no reproduce fielmente el esquema real ya aplicado (algunas
-- columnas `id`/FK quedaron declaradas distinto entre `schema.prisma` y la
-- BD real, provisionada originalmente con el script crudo) — un diff
-- automático contra ese historial intenta reescribir columnas existentes.
-- Esta migración solo agrega la tabla nueva, sin tocar nada existente.

create type "checkpoint_estado" as enum ('realizado', 'perdido');

create table "checkpoint" (
    "id"           uuid primary key default gen_random_uuid(),
    "turno_id"     uuid not null references "turno"(id) on delete cascade,
    "guardia_id"   uuid not null references "guardia"(id),
    "estado"       "checkpoint_estado" not null default 'realizado',
    "foto_url"     text,
    "lat"          double precision,
    "lng"          double precision,
    "capturado_en" timestamptz not null,
    "created_at"   timestamptz not null default now()
);

create index "ix_checkpoint_turno" on "checkpoint" ("turno_id");
create index "ix_checkpoint_guardia" on "checkpoint" ("guardia_id", "capturado_en" desc);
