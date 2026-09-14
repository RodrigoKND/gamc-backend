import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setEstadoOperativo } from '../guardias.service.js';

// El SOS real vive en guardia_telemetria (esSos/sosEstado), no en
// guardia.estadoOperativo — este test blinda el fix de hoy: resolver el
// estado operativo debe limpiar también el último ping en SOS, o el pin del
// mapa y el KPI del Dashboard quedan "pegados" en SOS para siempre.
//
// vi.mock() se hoistea sobre las declaraciones del archivo — vi.hoisted()
// evita el ReferenceError de usar estos mocks dentro del factory de vi.mock.
const {
  guardiaUpdate,
  guardiaFindUnique,
  telemetriaFindFirst,
  telemetriaUpdate,
  turnoFindMany,
  hechoCount,
  turnoCount,
  queryRaw,
  auditLogCreate,
} = vi.hoisted(() => ({
  guardiaUpdate: vi.fn().mockResolvedValue({}),
  guardiaFindUnique: vi.fn(),
  telemetriaFindFirst: vi.fn(),
  telemetriaUpdate: vi.fn().mockResolvedValue({}),
  turnoFindMany: vi.fn().mockResolvedValue([]),
  hechoCount: vi.fn().mockResolvedValue(0),
  turnoCount: vi.fn().mockResolvedValue(0),
  queryRaw: vi.fn().mockResolvedValue([]),
  auditLogCreate: vi.fn().mockResolvedValue({}),
}));

vi.mock('@infra/database', () => ({
  db: {
    guardia: { update: guardiaUpdate, findUnique: guardiaFindUnique },
    guardiaTelemetria: { findFirst: telemetriaFindFirst, update: telemetriaUpdate },
    turno: { findMany: turnoFindMany, count: turnoCount },
    hecho: { count: hechoCount },
    auditLog: { create: auditLogCreate },
    $queryRaw: queryRaw,
  },
}));

vi.mock('@infra/realtime', () => ({
  EVENTS: { guardiaUbicacion: 'guardia:ubicacion', guardiaEstado: 'guardia:estado' },
  publish: vi.fn(),
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

describe('setEstadoOperativo — limpieza de SOS real', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guardiaUpdate.mockResolvedValue({});
    guardiaFindUnique.mockResolvedValue(BASE_GUARDIA);
    turnoFindMany.mockResolvedValue([]);
    hechoCount.mockResolvedValue(0);
    turnoCount.mockResolvedValue(0);
    queryRaw.mockResolvedValue([]);
  });

  it('marca sosEstado=atendido en el último ping SOS pendiente al volver a en_servicio', async () => {
    telemetriaFindFirst.mockResolvedValue({ id: 42n, sosEstado: 'pendiente' });

    await setEstadoOperativo('g-1', 'en_servicio', 'actor-1');

    expect(telemetriaFindFirst).toHaveBeenCalledWith({
      where: { guardiaId: 'g-1', esSos: true },
      orderBy: { capturadoEn: 'desc' },
    });
    expect(telemetriaUpdate).toHaveBeenCalledWith({
      where: { id: 42n },
      data: expect.objectContaining({ esSos: false, sosEstado: 'atendido', sosAtendidoPorId: 'actor-1' }),
    });
  });

  it('no vuelve a actualizar un ping que ya estaba atendido', async () => {
    telemetriaFindFirst.mockResolvedValue({ id: 42n, sosEstado: 'atendido' });

    await setEstadoOperativo('g-1', 'en_servicio', 'actor-1');

    expect(telemetriaUpdate).not.toHaveBeenCalled();
  });

  it('no toca guardia_telemetria si no hay ningún ping en SOS', async () => {
    telemetriaFindFirst.mockResolvedValue(null);

    await setEstadoOperativo('g-1', 'en_servicio', 'actor-1');

    expect(telemetriaUpdate).not.toHaveBeenCalled();
  });

  it('no limpia el SOS si el nuevo estado es "emergencia" (activar SOS, no resolverlo)', async () => {

    await setEstadoOperativo('g-1', 'emergencia', 'actor-1');

    expect(telemetriaFindFirst).not.toHaveBeenCalled();
    expect(telemetriaUpdate).not.toHaveBeenCalled();
  });
});
