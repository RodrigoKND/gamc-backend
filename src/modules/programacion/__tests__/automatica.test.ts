import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { evaluar, puntosDeIncorporacion, radioDeBusqueda, type Destino, type FilaCandidato } from '../automatica.js';

vi.mock('@infra/database', () => ({ db: {} }));

// F6: bordes exactos de los requisitos automáticos y del punto de
// incorporación.

const AHORA = new Date('2026-10-20T12:00:00.000Z');
const SEDE = { lat: -17.401111, lng: -66.157417 };
const PUNTO: Destino = { trazado: null, punto: SEDE };
const RUTA: Destino = { trazado: [[SEDE.lng, SEDE.lat], [-66.1562, -17.4002], [-66.155, -17.399]], punto: null };

function fila(op: Partial<FilaCandidato> & { edadMin?: number; oesteM?: number } = {}): FilaCandidato {
  const { edadMin = 1, oesteM = 100, ...resto } = op;
  return {
    id: 'g1',
    primer_nombre: 'Ana',
    segundo_nombre: null,
    apellido_paterno: 'Rojas',
    apellido_materno: 'Vargas',
    estado_operativo: 'en_servicio',
    sos: false,
    ocupado: false,
    retirado: false,
    // ~1 m por 0,0000094° de longitud a esta latitud.
    lat: SEDE.lat,
    lng: SEDE.lng - oesteM / 106_300,
    capturado_en: new Date(AHORA.getTime() - edadMin * 60_000),
    bateria_pct: 80,
    precision_m: new Prisma.Decimal(10),
    ...resto,
  };
}

const motivo = (op: Parameters<typeof fila>[0], radio = 1000, destino = PUNTO) => evaluar(fila(op), destino, radio, AHORA).motivo;

describe('Requisitos automáticos: bordes', () => {
  it('GPS: menos de 10 min sirve; 10 min o más, no; sin captura, sin_gps', () => {
    expect(motivo({ edadMin: 9.9 })).toBeNull();
    expect(motivo({ edadMin: 10 })).toBe('gps_antiguo');
    expect(motivo({ capturado_en: null, lat: null, lng: null })).toBe('sin_gps');
  });

  it('precisión: hasta 100 m sirve, peor no; desconocida no descarta', () => {
    expect(motivo({ precision_m: new Prisma.Decimal(100) })).toBeNull();
    expect(motivo({ precision_m: new Prisma.Decimal(100.5) })).toBe('gps_impreciso');
    expect(motivo({ precision_m: null })).toBeNull();
  });

  it('batería: conocida y al menos 15 %', () => {
    expect(motivo({ bateria_pct: 15 })).toBeNull();
    expect(motivo({ bateria_pct: 14 })).toBe('bateria_baja');
    expect(motivo({ bateria_pct: null })).toBe('bateria_desconocida');
  });

  it('radio: dentro (o en el borde) sirve; más lejos, fuera_de_radio; a una ruta se mide al trazado', () => {
    expect(motivo({ oesteM: 990 }, 1000)).toBeNull();
    expect(motivo({ oesteM: 1100 }, 1000)).toBe('fuera_de_radio');
    // Cerca del tramo medio de la ruta (lejos de su inicio) también cuenta como cerca.
    const enMedio = evaluar(fila({ lat: -17.4006, lng: -66.1569, oesteM: 0 }), RUTA, 200, AHORA);
    expect(enMedio.motivo).toBeNull();
    expect(enMedio.distanciaM).toBeLessThan(200);
  });

  it('el primer requisito que falla es el motivo: SOS y servicio antes que ocupación, GPS, batería y radio', () => {
    const todoMal = { sos: true, ocupado: true, edadMin: 30, bateria_pct: 1, oesteM: 9000 };
    expect(motivo(todoMal)).toBe('sos');
    expect(motivo({ ...todoMal, sos: false, estado_operativo: 'emergencia' })).toBe('sos');
    expect(motivo({ ...todoMal, sos: false, estado_operativo: 'descanso' })).toBe('sin_turno');
    expect(motivo({ ...todoMal, sos: false })).toBe('ocupado');
    expect(motivo({ ...todoMal, sos: false, ocupado: false })).toBe('gps_antiguo');
    expect(motivo({ ...todoMal, sos: false, ocupado: false, edadMin: 1 })).toBe('bateria_baja');
  });

  it('informa distancia, antigüedad del GPS y batería para explicar la decisión', () => {
    const e = evaluar(fila({ oesteM: 500, edadMin: 3, bateria_pct: 42 }), PUNTO, 1000, AHORA);
    expect(e).toMatchObject({ guardiaId: 'g1', nombre: 'Ana Rojas Vargas', motivo: null, gpsEdadMin: 3, bateria: 42 });
    expect(e.distanciaM).toBeGreaterThan(480);
    expect(e.distanciaM).toBeLessThan(520);
  });
});

describe('Radio de búsqueda automático (3 km, +2 km cada 3 min, tope 20 km)', () => {
  const t = (min: number) => new Date(AHORA.getTime() + min * 60_000);

  it('empieza en 3 km y no crece antes de los 3 min', () => {
    expect(radioDeBusqueda(null, AHORA, t(2.9))).toMatchObject({ radioM: 3000, amplio: false });
  });

  it('a los 3 min sin nadie crece 2 km y la espera vuelve a contar desde ahí', () => {
    const r = radioDeBusqueda(3000, AHORA, t(3));
    expect(r).toMatchObject({ radioM: 5000, amplio: true });
    expect(r.desde).toEqual(t(3));
    expect(radioDeBusqueda(5000, r.desde, t(5))).toMatchObject({ radioM: 5000, amplio: false });
  });

  it('nunca pasa de 20 km', () => {
    expect(radioDeBusqueda(19_000, AHORA, t(3))).toMatchObject({ radioM: 20_000, amplio: true });
    expect(radioDeBusqueda(20_000, AHORA, t(60))).toMatchObject({ radioM: 20_000, amplio: false });
  });

  it('un guardia retirado por un operador de ESE horario no vuelve (motivo propio)', () => {
    expect(motivo({ retirado: true })).toBe('retirado');
    expect(motivo({ retirado: true, ocupado: true })).toBe('ocupado');
  });
});

describe('Punto de incorporación', () => {
  const g = (id: string, lat: number, lng: number) => ({ guardiaId: id, nombre: id, motivo: null, distanciaM: 0, gpsEdadMin: 1, bateria: 80, posicion: { lat, lng } });

  it('coche y moto: un punto común (el vértice más cercano al centro del grupo)', () => {
    const p = puntosDeIncorporacion('coche', RUTA, [g('a', -17.4011, -66.1580), g('b', -17.3989, -66.1545)]);
    expect(p.get('a')).toEqual(p.get('b'));
    expect(p.get('a')).toEqual([-66.1562, -17.4002]);
  });

  it('a pie: cada uno al vértice más cercano a él; punto fijo: sin punto (lo fija el motor)', () => {
    const p = puntosDeIncorporacion('a_pie', RUTA, [g('a', -17.4011, -66.1580), g('b', -17.3989, -66.1545)]);
    expect(p.get('a')).toEqual([SEDE.lng, SEDE.lat]);
    expect(p.get('b')).toEqual([-66.155, -17.399]);
    expect(puntosDeIncorporacion('punto_fijo', PUNTO, [g('a', 0, 0)]).size).toBe(0);
  });
});
