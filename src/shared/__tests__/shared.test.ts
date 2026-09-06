import { describe, it, expect } from 'vitest';
import { can } from '@shared/policies';
import { nombreCompleto } from '@shared/names';
import { sha256, randomResetCode } from '@shared/security';

describe('políticas RBAC', () => {
  const perms = {
    guardias: { ver: true, crear: true, editar: true, eliminar: false },
    mapas: { ver: true, crear: false, editar: false, eliminar: false },
  };

  it('permite ver/crear/editar sobre recurso otorgado', () => {
    expect(can(perms, 'guardias', 'ver')).toBe(true);
    expect(can(perms, 'guardias', 'crear')).toBe(true);
    expect(can(perms, 'guardias', 'editar')).toBe(true);
  });

  it('niega lo no otorgado', () => {
    expect(can(perms, 'guardias', 'eliminar')).toBe(false);
    expect(can(perms, 'mapas', 'editar')).toBe(false);
    expect(can(perms, 'usuarios', 'ver')).toBe(false);
  });
});

describe('nombres', () => {
  it('con segundo nombre', () => {
    expect(nombreCompleto({ primerNombre: 'María', segundoNombre: 'Fernanda', apellidoPaterno: 'Rojas', apellidoMaterno: 'Vargas' })).toBe('María Fernanda Rojas Vargas');
  });

  it('sin segundo nombre', () => {
    expect(nombreCompleto({ primerNombre: 'Carlos', segundoNombre: null, apellidoPaterno: 'Mendoza', apellidoMaterno: 'Toro' })).toBe('Carlos Mendoza Toro');
    expect(nombreCompleto({ primerNombre: 'Jorge', apellidoPaterno: 'Quispe', apellidoMaterno: 'Cruz' })).toBe('Jorge Quispe Cruz');
  });
});

describe('seguridad (utilidades)', () => {
  it('sha256 es determinista', () => {
    expect(sha256('x')).toBe(sha256('x'));
    expect(sha256('x')).not.toBe(sha256('y'));
  });

  it('código de recuperación es de 6 dígitos', () => {
    expect(randomResetCode(6)).toMatch(/^\d{6}$/);
    expect(randomResetCode(6).length).toBe(6);
  });
});