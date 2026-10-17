import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setEstadoOperativo } from '../guardias.service.js';

// El SOS real vive en guardia_telemetria (esSos/sosEstado), no en
// guardia.estadoOperativo. Resolver el estado operativo (endpoint de
// compatibilidad) debe atender TODAS las alertas abiertas — antes solo la
// última, y las anteriores quedaban pendientes — en la MISMA transacción que
// el cambio de estado, y conservar es_sos = true como historial (F2).
//
// vi.mock() se hoistea sobre las declaraciones del archivo — vi.hoisted()
// evita el ReferenceError de usar estos mocks dentro del factory de vi.mock.
const {
  guardiaUpdate,
  guardiaFindUnique,
  telemetriaUpdateMany,
  turnoFindMany,
  hechoCount,
  turnoCount,
  queryRaw,
  auditLogCreate,
} = vi.hoisted(() => ({
  guardiaUpdate: vi.fn().mockResolvedValue({}),
  guardiaFindUnique: vi.fn(),
  telemetriaUpdateMany: vi.fn().mockResolvedValue({ count: 0 }),
  turnoFindMany: vi.fn().mockResolvedValue([]),
  hechoCount: vi.fn().mockResolvedValue([]),
  turnoCount: vi.fn().mockResolvedValue(0),
  queryRaw: vi.fn().mockResolvedValue([]),
  auditLogCreate: vi.fn().mockResolvedValue({}),
}));

vi.mock('@infra/database', () => {
  const tx = {
    guardia: { update: guardiaUpdate },
    guardiaTelemetria: { updateMany: telemetriaUpdateMany },
  };
  return {
    db: {
      guardia: { update: guardiaUpdate, findUnique: guardiaFindUnique },
      guardiaTelemetria: { updateMany: telemetriaUpdateMany },
      turno: { findMany: turnoFindMany, count: turnoCount },
      // F3: conteo de hechos por guardia (groupBy) y EPI actual del guardia.
      hecho: { groupBy: hechoCount },
      guardiaUbicacionActual: { findMany: vi.fn().mockResolvedValue([]) },
      auditLog: { create: auditLogCreate },
      $queryRaw: queryRaw,
      $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
    },
  };
});

vi.mock('@infra/realtime', () => ({
  EVENTS: { guardiaUbicacion: 'guardia:ubicacion', guardiaEstado: 'guardia:estado', sosNuevo: 'sos:nuevo' },
  publish: vi.fn(),
  isRealtimeReady: () => false,
}));

const BASE_GUARDIA = {
  id: 'g-1',
  primerNombre: 'Karen',
  segundoNombre: null,
  apellidoPaterno: 'Ferreira',
  apellidoMaterno: 'Noa',
  ci: '8123456',
  usuario: 'k.ferreira',
  telefono: '74567890',
  fotoUrl: null,
  fechaNacimiento: new Date('1996-07-25'),
  epiId: null,
  epi: null,
  estado: 'activo',
  estadoOperativo: 'en_servicio',
  debeCambiarPassword: false,
  activadoEn: null,
  createdAt: new Date(),
};

describe('setEstadoOperativo — atención de SOS (compatibilidad)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guardiaUpdate.mockResolvedValue({});
    guardiaFindUnique.mockResolvedValue(BASE_GUARDIA);
    telemetriaUpdateMany.mockResolvedValue({ count: 2 });
    turnoFindMany.mockResolvedValue([]);
    hechoCount.mockResolvedValue([]);
    turnoCount.mockResolvedValue(0);
    queryRaw.mockResolvedValue([]);
  });

  it('al salir de emergencia atiende TODAS las alertas abiertas, conservando es_sos', async () => {
    await setEstadoOperativo('g-1', 'en_servicio', 'actor-1');

    expect(guardiaUpdate).toHaveBeenCalledWith({ where: { id: 'g-1' }, data: { estadoOperativo: 'en_servicio' } });
    expect(telemetriaUpdateMany).toHaveBeenCalledWith({
      where: { guardiaId: 'g-1', esSos: true, OR: [{ sosEstado: null }, { sosEstado: 'pendiente' }] },
      data: expect.objectContaining({ sosEstado: 'atendido', sosAtendidoPorId: 'actor-1' }),
    });
    const data = telemetriaUpdateMany.mock.calls[0]![0].data;
    expect(data).not.toHaveProperty('esSos');
  });

  it('solo actualiza alertas pendientes (las ya atendidas quedan fuera del filtro)', async () => {
    await setEstadoOperativo('g-1', 'fuera_de_servicio', 'actor-1');

    const where = telemetriaUpdateMany.mock.calls[0]![0].where;
    expect(where.OR).toEqual([{ sosEstado: null }, { sosEstado: 'pendiente' }]);
  });

  it('no atiende SOS si el nuevo estado es "emergencia" (activar SOS, no resolverlo)', async () => {
    await setEstadoOperativo('g-1', 'emergencia', 'actor-1');

    expect(guardiaUpdate).toHaveBeenCalled();
    expect(telemetriaUpdateMany).not.toHaveBeenCalled();
  });
});
