-- =============================================================================
-- 0002 · Distancia de turno con filtro anti-ruido del GPS
-- =============================================================================
-- Problema: `fn_turno_distancia` sumaba el haversine entre TODAS las lecturas
-- consecutivas de `guardia_telemetria`. De pie, el GPS deriva unos metros por
-- lectura (cada ~15 s), y eso inflaba el total: un guardia sin moverse 2 min
-- cerraba el turno con "3 m" recorridos.
--
-- Fix: solo se suma un tramo si el desplazamiento entre las dos lecturas supera
-- un umbral = max(10 m, precision_reportada_A + precision_reportada_B). Mientras
-- el móvil no envíe `precision_m` (hoy va null) el umbral efectivo es 10 m, que
-- descarta la deriva típica sin perder el movimiento real (caminando, cada
-- tramo queda muy por encima).
-- =============================================================================

create or replace function fn_turno_distancia(p_turno uuid) returns numeric as $$
  with p as (
    select lat, lng, precision_m,
           lag(lat)         over w as plat,
           lag(lng)         over w as plng,
           lag(precision_m) over w as pprec
    from guardia_telemetria
    where turno_id = p_turno
    window w as (order by capturado_en)
  ),
  tramos as (
    select fn_haversine_m(plat, plng, lat, lng) as d,
           greatest(10, coalesce(precision_m, 0) + coalesce(pprec, 0)) as umbral
    from p
    where plat is not null
  )
  select coalesce(round(sum(d)::numeric, 2), 0)
  from tramos
  where d >= umbral;
$$ language sql stable;
