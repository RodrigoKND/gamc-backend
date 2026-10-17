import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recortarRecorrido, ventanasAutorizadas } from '../turnos.service.js';

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock('@infra/database', () => ({ db: { patrulla: { findMany } } }));
vi.mock('@infra/realtime', () => ({ EVENTS: {}, publish: vi.fn(), publishTerritorial: vi.fn() }));
vi.mock('@modules/auditoria/auditoria.service', () => ({ logAudit: vi.fn() }));
vi.mock('@modules/ejecuciones/ejecuciones.service', () => ({ salirDeRutaPorFinDeTurno: vi.fn() }));
vi.mock('@modules/mapas/mapas.service', () => ({ whereVigente: vi.fn() }));

const hora = (h: number) => new Date(`2026-10-17T${String(h).padStart(2, '0')}:00:00Z`);
const patrulla = (patch = {}) => ({ estado: 'en_curso', iniciadaEn: hora(10), createdAt: hora(9), completadaEn: null, ejecucion: null, ...patch });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(hora(14)); findMany.mockReset(); });
afterEach(() => vi.useRealTimers());

describe('Privacidad del recorrido por EPI', () => {
  it('no autoriza GPS con patrullas históricas sin cierre conocido', async () => {
    findMany.mockResolvedValue([patrulla({ estado: 'cancelada' }), patrulla({ estado: 'completada' })]);
    expect(await ventanasAutorizadas('guardia', 'epi')).toEqual([]);
  });
  it('limita el recorrido histórico al cierre de la patrulla', async () => {
    findMany.mockResolvedValue([patrulla({ estado: 'completada', completadaEn: hora(11) })]);
    const ventanas = await ventanasAutorizadas('guardia', 'epi');
    const puntos = [9, 10, 11, 12].map((h) => ({ lat: 0, lng: 0, esSos: false, capturadoEn: hora(h) }));
    const r = recortarRecorrido({ turnoId: 'turno', guardiaId: 'guardia', total: 4, distanciaMetros: 100, puntos }, ventanas);
    expect(r.puntos.map((p) => p.capturadoEn)).toEqual([hora(10), hora(11)]);
    expect(r.distanciaMetros).toBeNull();
  });
  it('no revela GPS anterior a un horario reservado ni posterior a su fin', async () => {
    findMany.mockResolvedValue([patrulla({ estado: 'asignada', iniciadaEn: null, ejecucion: { inicio: hora(11), fin: hora(13), cerradaEn: null, estado: 'activa' } })]);
    expect(await ventanasAutorizadas('guardia', 'epi')).toEqual([{ desde: hora(11), hasta: hora(13) }]);
  });
  it('un horario futuro no autoriza puntos actuales', async () => {
    findMany.mockResolvedValue([patrulla({ estado: 'asignada', iniciadaEn: null, ejecucion: { inicio: hora(15), fin: hora(16), cerradaEn: null, estado: 'pendiente' } })]);
    expect(await ventanasAutorizadas('guardia', 'epi')).toEqual([]);
  });
  it('respeta el cierre de la ejecución aunque la patrulla siga activa', async () => {
    findMany.mockResolvedValue([patrulla({ ejecucion: { inicio: hora(10), fin: hora(15), cerradaEn: hora(12), estado: 'cancelada' } })]);
    expect(await ventanasAutorizadas('guardia', 'epi')).toEqual([{ desde: hora(10), hasta: hora(12) }]);
  });
  it('una patrulla en curso autoriza solo hasta ahora', async () => {
    findMany.mockResolvedValue([patrulla()]);
    expect(await ventanasAutorizadas('guardia', 'epi')).toEqual([{ desde: hora(10), hasta: hora(14) }]);
  });
});
