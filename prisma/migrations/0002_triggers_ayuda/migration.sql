-- =============================================================================
-- GAMC · Seguridad Ciudadana — Triggers de ayuda (0002)
--
-- Aditiva sobre 0001_init: no modifica tablas, columnas, tipos, FKs ni datos
-- existentes. Ningún nombre de tabla/columna cambia, por lo que no afecta al
-- cliente móvil ni requiere cambios en su código.
--
-- Documentado en detalle, con justificación de cada trigger, en
-- unificacion/BD_Funciones.md.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) SOS -> guardia.estado_operativo = 'emergencia'
--    Refuerza a nivel de BD la invariante que hoy solo vive en
--    telemetry.service.ts (ingestTelemetry). Se dispara sobre CUALQUIER
--    inserción en guardia_telemetria con es_sos = true, sin importar qué
--    cliente (web, móvil actual o futuro) haya escrito la fila.
-- -----------------------------------------------------------------------------
create or replace function fn_sos_a_emergencia() returns trigger as $$
begin
  if new.es_sos then
    update guardia
       set estado_operativo = 'emergencia'
     where id = new.guardia_id
       and estado_operativo <> 'emergencia';
  end if;
  return new;
end $$ language plpgsql;

create trigger trg_telemetria_sos_emergencia
  after insert on guardia_telemetria
  for each row execute function fn_sos_a_emergencia();

-- -----------------------------------------------------------------------------
-- 2) hecho.estado_cambiado_en automático al cambiar hecho.estado
--    Mismo patrón mecánico que set_updated_at() (0001_init, sección 7.1):
--    pura contabilidad de auditoría, no lógica de negocio. Evita que una
--    fila quede con estado_cambiado_por seteado pero estado_cambiado_en nulo
--    si algún cliente olvida setearlo.
-- -----------------------------------------------------------------------------
create or replace function fn_hecho_estado_cambiado() returns trigger as $$
begin
  if new.estado is distinct from old.estado then
    new.estado_cambiado_en = now();
  end if;
  return new;
end $$ language plpgsql;

create trigger trg_hecho_estado_cambiado
  before update on hecho
  for each row execute function fn_hecho_estado_cambiado();

-- -----------------------------------------------------------------------------
-- 3) CHECK: un turno 'finalizado' debe traer hora_fin/lat_fin/lng_fin
--    El cierre de turno es una sola acción de usuario ("fin de servicio"
--    captura hora y ubicación en el momento antes de desconectar), por lo
--    que el cliente siempre debería enviar los 3 campos junto con el cambio
--    de estado en una sola escritura. Declarativo, sin función que mantener.
-- -----------------------------------------------------------------------------
alter table turno add constraint chk_turno_finalizado_completo
  check (estado <> 'finalizado' or (hora_fin is not null and lat_fin is not null and lng_fin is not null));
