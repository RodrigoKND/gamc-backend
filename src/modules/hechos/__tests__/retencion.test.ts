import { describe, expect, it, vi } from 'vitest';

const AHORA = new Date('2026-01-31T00:00:00.000Z');

function crearDeps(hechos: Array<{ id: string; evidencias: Array<{ url: string }> }>) {
  const findMany = vi.fn(async (_args: unknown) => hechos);
  const deleteMany = vi.fn(async (_args: unknown) => ({ count: hechos.length }));
  const eliminarArchivo = vi.fn(async (_url: string) => {});
  return {
    db: { hecho: { findMany, deleteMany } },
    eliminarArchivo,
    ahora: AHORA,
    findMany,
    deleteMany,
    eliminarArchivoSpy: eliminarArchivo,
  };
}

describe('barridoRetencionHechos', () => {
  it('aplica 1/15/30 días según el nivel y elimina las evidencias antes que los hechos', async () => {
    const d = crearDeps([
      { id: 'hecho-bajo', evidencias: [{ url: 'http://localhost:8080/media/fotos/11111111-1111-4111-8111-111111111111.png' }] },
      { id: 'hecho-alto', evidencias: [{ url: 'http://localhost:8080/media/videos/22222222-2222-4222-8222-222222222222.mp4' }] },
    ]);
    const { barridoRetencionHechos } = await import('../retencion.js');

    const resultado = await barridoRetencionHechos({
      db: d.db,
      eliminarArchivo: d.eliminarArchivo,
      ahora: d.ahora,
    });

    expect(d.findMany.mock.calls[0]![0]).toEqual({
      where: {
        OR: [
          { nivelRiesgo: 'bajo', reportadoEn: { lt: new Date('2026-01-30T00:00:00.000Z') } },
          { nivelRiesgo: 'medio', reportadoEn: { lt: new Date('2026-01-16T00:00:00.000Z') } },
          { nivelRiesgo: { in: ['alto', 'muy_alto'] }, reportadoEn: { lt: new Date('2026-01-01T00:00:00.000Z') } },
        ],
      },
      take: 100,
      select: { id: true, evidencias: true },
    });
    expect(d.eliminarArchivoSpy.mock.calls.map((c) => c[0])).toEqual([
      'http://localhost:8080/media/fotos/11111111-1111-4111-8111-111111111111.png',
      'http://localhost:8080/media/videos/22222222-2222-4222-8222-222222222222.mp4',
    ]);
    expect(d.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['hecho-bajo', 'hecho-alto'] } } });
    expect(resultado).toEqual({ revisados: 2, eliminados: 2 });
  });

  it('no borra nada cuando ningún reporte alcanzó su plazo', async () => {
    const d = crearDeps([]);
    const { barridoRetencionHechos } = await import('../retencion.js');

    const resultado = await barridoRetencionHechos({
      db: d.db,
      eliminarArchivo: d.eliminarArchivo,
      ahora: d.ahora,
    });

    expect(d.deleteMany).not.toHaveBeenCalled();
    expect(d.eliminarArchivoSpy).not.toHaveBeenCalled();
    expect(resultado).toEqual({ revisados: 0, eliminados: 0 });
  });
});
