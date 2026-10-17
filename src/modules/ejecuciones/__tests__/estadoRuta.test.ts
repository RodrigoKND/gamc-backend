import { describe, expect, it, vi } from 'vitest';
import { estadoFueraDeRuta, evaluarEstadoRuta, franjaHoraria, limiteIncorporacion } from '../estadoRuta.js';

vi.mock('@infra/database', () => ({ db: {} }));

// F7: plazo para incorporarse. Bordes del cálculo y de la
// clasificación al vencer.

// Martes 20/10/2026, hora de Bolivia (UTC-4).
const PICO = new Date('2026-10-20T12:00:00.000Z'); // 08:00
const DIURNA = new Date('2026-10-20T15:00:00.000Z'); // 11:00
const NOCHE = new Date('2026-10-20T04:00:00.000Z'); // 00:00

const segundos = (limite: Date, desde: Date) => (limite.getTime() - desde.getTime()) / 1000;

// Trazado este-oeste; ~0,000009° de latitud ≈ 1 m.
const RUTA: [number, number][] = [[-66.16, -17.4], [-66.15, -17.4]];
const aNorte = (m: number): [number, number] => [-66.155, -17.4 + m / 110_600];

describe('franjaHoraria', () => {
  it('distingue pico, diurna y nocturna en hora de Bolivia', () => {
    expect(franjaHoraria(PICO)).toBe('pico');
    expect(franjaHoraria(DIURNA)).toBe('diurna');
    expect(franjaHoraria(NOCHE)).toBe('nocturna');
  });
});

describe('limiteIncorporacion', () => {
  it('coche: recta × sinuosidad a 30 km/h × factor pesimista + arranque', () => {
    expect(segundos(limiteIncorporacion(1000, 'coche', DIURNA), DIURNA)).toBe(321);
    expect(segundos(limiteIncorporacion(5000, 'coche', NOCHE), NOCHE)).toBe(1077);
  });

  it('nunca menos de 5 min, aunque esté al lado', () => {
    expect(segundos(limiteIncorporacion(100, 'a_pie', DIURNA), DIURNA)).toBe(300);
    expect(segundos(limiteIncorporacion(0, 'coche', PICO), PICO)).toBe(300);
  });

  it('a pie con equipo ≈ 4,5 km/h', () => {
    expect(segundos(limiteIncorporacion(2000, 'a_pie', PICO), PICO)).toBe(2592);
  });

  it('punto fijo: a pie hasta 1,5 km, en vehículo más lejos', () => {
    expect(segundos(limiteIncorporacion(1000, 'punto_fijo', DIURNA), DIURNA)).toBe(1296);
    expect(segundos(limiteIncorporacion(3000, 'punto_fijo', DIURNA), DIURNA)).toBe(841);
  });

  it('modalidad desconocida se trata como coche', () => {
    expect(limiteIncorporacion(1000, null, DIURNA)).toEqual(limiteIncorporacion(1000, 'coche', DIURNA));
  });
});

describe('evaluarEstadoRuta con plazo', () => {
  it('lejos y sin vencer: sigue incorporándose', () => {
    expect(evaluarEstadoRuta(aNorte(1000), RUTA, 'coche', false, false)?.estado).toBe('incorporandose');
  });

  it('plazo vencido sin llegar: amarillo o rojo según la distancia', () => {
    expect(evaluarEstadoRuta(aNorte(200), RUTA, 'coche', false, true)).toMatchObject({ estado: 'advertencia', seIncorpora: false });
    expect(evaluarEstadoRuta(aNorte(1000), RUTA, 'coche', false, true)).toMatchObject({ estado: 'alerta', seIncorpora: false });
  });

  it('llega tarde: se incorpora igual (verde)', () => {
    expect(evaluarEstadoRuta(aNorte(20), RUTA, 'coche', false, true)).toMatchObject({ estado: 'en_ruta', seIncorpora: true });
  });

  it('ya incorporado: el plazo no cambia nada', () => {
    expect(evaluarEstadoRuta(aNorte(200), RUTA, 'coche', true, false)?.estado).toBe('advertencia');
  });
});

describe('estadoFueraDeRuta', () => {
  it('usa el umbral amarillo de la modalidad; sin distancia → alerta', () => {
    expect(estadoFueraDeRuta(150, 'a_pie')).toBe('advertencia');
    expect(estadoFueraDeRuta(151, 'a_pie')).toBe('alerta');
    expect(estadoFueraDeRuta(null, 'coche')).toBe('alerta');
  });
});
