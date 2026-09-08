import type { Prisma } from '@prisma/client';
import { db } from '@infra/database';

// Patrulla vigente del guardia (BD_UNIFICADA §4). El móvil la pide al abrir el
// mapa y usa `trazado` (de la ruta_plantilla) en vez del polígono mock.
// Se lee de la vista `v_patrulla_vigente` (estado asignada|en_curso + fecha = hoy).

export interface PatrullaVigenteRow {
  id: string;
  guardiaId: string;
  estado: string;
  fecha: Date;
  nombre: string | null;
  descripcion: string | null;
  notas: string | null;
  epiId: string | null;
  rutaPlantillaId: string | null;
  rutaNombre: string | null;
  trazado: Prisma.JsonValue | null;
  poligonoGeojson: Prisma.JsonValue | null;
  turnoId: string | null;
  horaInicioPrevista: string | null;
  iniciadaEn: Date | null;
}

export async function patrullaVigenteDeGuardia(
  guardiaId: string,
): Promise<PatrullaVigenteRow | null> {
  const rows = await db.$queryRaw<PatrullaVigenteRow[]>`
    select
      id,
      guardia_id            as "guardiaId",
      estado::text          as estado,
      fecha,
      nombre,
      descripcion,
      notas,
      epi_id                as "epiId",
      ruta_plantilla_id     as "rutaPlantillaId",
      ruta_nombre           as "rutaNombre",
      trazado,
      poligono_geojson      as "poligonoGeojson",
      turno_id              as "turnoId",
      to_char(hora_inicio_prevista, 'HH24:MI') as "horaInicioPrevista",
      iniciada_en           as "iniciadaEn"
    from v_patrulla_vigente
    where guardia_id = ${guardiaId}::uuid
    order by created_at desc
    limit 1`;
  return rows[0] ?? null;
}
