import { describe, expect, it, vi } from 'vitest';

vi.mock('@infra/database', () => ({ db: {} }));
import { decidirDespacho, epiDeEscalamiento, ordenarEpisParaSos, type EpiSos } from '../sosDespacho.js';

// Tres EPIs en fila (oeste → este), cuadrados de ~1,1 km.
const cuadrado = (x0: number): EpiSos['poligonos'] => [[[[x0, 0], [x0 + 0.01, 0], [x0 + 0.01, 0.01], [x0, 0.01], [x0, 0]]]];
const EPIS: EpiSos[] = [
  { id: 'a', codigo: 'oeste', nombre: 'EPI Oeste', sede: { lng: 0.005, lat: 0.005 }, poligonos: cuadrado(0) },
  { id: 'b', codigo: 'centro', nombre: 'EPI Centro', sede: { lng: 0.015, lat: 0.005 }, poligonos: cuadrado(0.01) },
  { id: 'c', codigo: 'este', nombre: 'EPI Este', sede: { lng: 0.025, lat: 0.005 }, poligonos: cuadrado(0.02) },
];
const conectados = (ids: string[]) => (epiId: string) => (ids.includes(epiId) ? 1 : 0);

describe('ordenarEpisParaSos', () => {
  it('pone primero la EPI que contiene el SOS y luego las vecinas por cercanía', () => {
    const orden = ordenarEpisParaSos([0.012, 0.005], EPIS);
    expect(orden.map((e) => e.codigo)).toEqual(['centro', 'oeste', 'este']);
    expect(orden[0]).toMatchObject({ contiene: true, distanciaM: 0 });
  });

  it('fuera de toda cobertura, la EPI más cercana es la responsable', () => {
    const orden = ordenarEpisParaSos([0.04, 0.005], EPIS);
    expect(orden[0]).toMatchObject({ codigo: 'este', contiene: false });
  });
});

describe('decidirDespacho', () => {
  const orden = ordenarEpisParaSos([0.012, 0.005], EPIS);

  it('lo atiende el operador de la EPI del territorio', () => {
    expect(decidirDespacho(orden, conectados(['a', 'b', 'c']))).toMatchObject({ responsable: { id: 'b' }, atiende: { id: 'b' }, motivo: 'territorio' });
  });

  it('sin operador conectado en esa EPI, pasa a la más cercana que tenga', () => {
    expect(decidirDespacho(orden, conectados(['c']))).toMatchObject({ responsable: { id: 'b' }, atiende: { id: 'c' }, motivo: 'sin_operador_en_epi' });
  });

  it('sin operadores en ninguna EPI, queda sin asignar (lo toma el Administrador)', () => {
    expect(decidirDespacho(orden, conectados([]))).toMatchObject({ responsable: { id: 'b' }, atiende: null, motivo: 'sin_operadores_conectados' });
  });
});

describe('epiDeEscalamiento', () => {
  it('escala a la siguiente EPI más cercana con operadores', () => {
    const orden = ordenarEpisParaSos([0.012, 0.005], EPIS);
    const hay = conectados(['a', 'b', 'c']);
    expect(epiDeEscalamiento(orden, decidirDespacho(orden, hay), hay)?.id).toBe('a');
  });
});
