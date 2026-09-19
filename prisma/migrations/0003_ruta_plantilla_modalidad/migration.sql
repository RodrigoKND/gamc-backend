-- =============================================================================
-- 0003 · Modalidad de patrullaje en ruta_plantilla
-- =============================================================================
-- Problema: al asignar una ruta, el Operador elige la modalidad (a pie, moto,
-- coche, punto fijo, oficina) desde la Web, pero esa elección nunca se
-- guardaba — `ruta_plantilla` no tenía dónde persistirla, así que al releer
-- la plantilla (recarga, "Usar Plantilla Guardada") siempre volvía a
-- asumirse "coche". El trazado en sí ya seguía calles/sendas reales según la
-- modalidad elegida (perfil de ruteo distinto en el cliente), pero el dato
-- de qué modalidad se usó se perdía.
--
-- Fix: columna nullable (una ruta vieja, de antes de este cambio, no tiene
-- modalidad conocida — se sigue tratando como "coche" en el código, no acá).
-- =============================================================================

alter table ruta_plantilla add column if not exists modalidad text;
