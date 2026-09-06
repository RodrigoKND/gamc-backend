export interface NombrePartes {
  primerNombre: string;
  segundoNombre?: string | null;
  apellidoPaterno: string;
  apellidoMaterno: string;
}

/** Misma lógica que la columna GENERATED `nombre` del schema: trim(concat_ws(...)). */
export function nombreCompleto(r: NombrePartes): string {
  return [r.primerNombre, r.segundoNombre, r.apellidoPaterno, r.apellidoMaterno]
    .filter(Boolean)
    .join(' ')
    .trim();
}