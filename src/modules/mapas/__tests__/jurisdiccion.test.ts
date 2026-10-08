import { describe, expect, it, vi } from 'vitest';
import { exigirDentroDeEpi, exigirMismaEpi, jurisdiccionDe, puntoEnPoligonos, puntosDe, type Jurisdiccion } from '../jurisdiccion.js';
import { db } from '@infra/database';

vi.mock('@infra/database', () => ({ db: { user: { findUnique: vi.fn() } } }));

const CUADRADO: [number, number][][][] = [[[
  [-66.2, -17.4],
  [-66.1, -17.4],
  [-66.1, -17.3],
  [-66.2, -17.3],
  [-66.2, -17.4],
]]];

const JURISDICCION: Jurisdiccion = {
  epiId: 'epi-central',
  epiCodigo: 'central',
  epiNombre: 'EPI Central',
  poligonos: CUADRADO,
};

describe('jurisdicción por EPI', () => {
  it('bloquea una cuenta sin EPI asignada', async () => {
    vi.mocked(db.user.findUnique).mockResolvedValueOnce(null);
    await expect(jurisdiccionDe({ id: 'operador', role: 'operador_monitoreo' })).rejects.toThrow(/no tiene una EPI/i);
  });

  it('exime al superadministrador de la restricción territorial', async () => {
    expect(await jurisdiccionDe({ id: 'superadmin', role: 'super_admin' })).toBeNull();
    expect(() => exigirMismaEpi(null, 'otra-epi', 'Guardia')).not.toThrow();
    expect(() => exigirDentroDeEpi(null, [[-65, -16]])).not.toThrow();
  });

  it('acepta registros propios y rechaza otra EPI o registros sin EPI', () => {
    expect(() => exigirMismaEpi(JURISDICCION, 'epi-central', 'Guardia')).not.toThrow();
    expect(() => exigirMismaEpi(JURISDICCION, 'epi-norte', 'Guardia')).toThrow(/no pertenece/i);
    expect(() => exigirMismaEpi(JURISDICCION, null, 'Guardia')).toThrow(/no pertenece/i);
  });
  it('acepta un punto dentro del polígono y rechaza uno fuera', () => {
    expect(puntoEnPoligonos([-66.15, -17.35], CUADRADO)).toBe(true);
    expect(puntoEnPoligonos([-66.3, -17.35], CUADRADO)).toBe(false);
  });

  it('extrae coordenadas tanto de GeoJSON como del trazado plano', () => {
    expect(puntosDe({ type: 'Point', coordinates: [-66.15, -17.35] })).toEqual([[-66.15, -17.35]]);
    expect(puntosDe([[-66.16, -17.36], [-66.15, -17.35]])).toHaveLength(2);
  });

  it('rechaza trazados que salgan de la EPI', () => {
    expect(() => exigirDentroDeEpi(JURISDICCION, [[-66.15, -17.35], [-66.3, -17.35]])).toThrow(/sale de los límites/i);
  });

  it('falla cerrado cuando la EPI no tiene polígono', () => {
    expect(() => exigirDentroDeEpi({ ...JURISDICCION, poligonos: [] }, [[-66.15, -17.35]])).toThrow(/no tiene límites/i);
  });

  it('rechaza geometrías vacías o inválidas', () => {
    expect(() => exigirDentroDeEpi(JURISDICCION, null)).toThrow(/no contiene coordenadas/i);
  });

  // H12 (cambios/02): antes solo se revisaban los VÉRTICES. En una EPI en
  // forma de U, un tramo entre dos vértices interiores cruzaba el hueco
  // exterior y el backend lo aceptaba.
  describe('contención del trazado completo', () => {
    // U: brazos x∈[-66.20,-66.18] y x∈[-66.15,-66.13], base y∈[-17.40,-17.38];
    // el hueco (x∈(-66.18,-66.15), y>-17.38) es exterior.
    const U: Jurisdiccion = {
      ...JURISDICCION,
      poligonos: [[[
        [-66.2, -17.4], [-66.13, -17.4], [-66.13, -17.3], [-66.15, -17.3], [-66.15, -17.38],
        [-66.18, -17.38], [-66.18, -17.3], [-66.2, -17.3], [-66.2, -17.4],
      ]]],
    };

    it('rechaza un tramo cuyos dos extremos están dentro pero cruza el exterior', () => {
      expect(() => exigirDentroDeEpi(U, [[-66.19, -17.33], [-66.14, -17.33]])).toThrow(/sale de los límites/i);
    });

    it('acepta el mismo recorrido si rodea la U por dentro', () => {
      expect(() => exigirDentroDeEpi(U, [[-66.19, -17.33], [-66.19, -17.39], [-66.14, -17.39], [-66.14, -17.33]])).not.toThrow();
    });

    it('rechaza el salto entre dos islas de un MultiPolygon', () => {
      const islas: Jurisdiccion = {
        ...JURISDICCION,
        poligonos: [
          [[[-66.2, -17.4], [-66.18, -17.4], [-66.18, -17.38], [-66.2, -17.38], [-66.2, -17.4]]],
          [[[-66.15, -17.4], [-66.13, -17.4], [-66.13, -17.38], [-66.15, -17.38], [-66.15, -17.4]]],
        ],
      };
      expect(() => exigirDentroDeEpi(islas, [[-66.19, -17.39], [-66.14, -17.39]])).toThrow(/sale de los límites/i);
      expect(() => exigirDentroDeEpi(islas, { type: 'Point', coordinates: [-66.14, -17.39] })).not.toThrow();
    });

    it('rechaza coordenadas no finitas o fuera de rango en vez de ignorarlas', () => {
      expect(() => exigirDentroDeEpi(JURISDICCION, [[-66.15, -17.35], [Number.NaN, -17.35]])).toThrow(/no contiene coordenadas/i);
      expect(() => exigirDentroDeEpi(JURISDICCION, [[-66.15, -17.35], [-266, -17.35]])).toThrow(/no contiene coordenadas/i);
    });
  });
});
