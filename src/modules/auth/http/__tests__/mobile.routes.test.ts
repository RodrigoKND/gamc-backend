import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { errorHandler, Errors } from '@shared/errors';
import { buildMobileAuthRouter } from '@modules/auth/http/mobile.routes';
import type { AuthService } from '@modules/auth/application/auth.service';
import type { TokenService } from '@modules/auth/application/token.service';

// Cubre el contrato HTTP que la app móvil ya publicada (APK) no puede
// renegociar: un 401 significa "token vencido" para su cliente, así que un
// login con contraseña incorrecta NO puede responder 401 o el guardia ve
// "La sesión expiró" en vez de "Usuario o contraseña incorrectos".
//
// Se prueba contra el router real (controller + schema + errorHandler central)
// porque lo sutil no es el `if`, sino que el middleware de error quede
// registrado DESPUÉS de las rutas para que Express lo alcance.

const SESION_VALIDA = {
  accessToken: 'access-token-de-prueba',
  refreshToken: 'refresh-token-de-prueba',
  guardia: { id: 'g-1', usuario: 'guardia1', nombre: 'Guardia Uno' },
};

let server: Server;
let baseUrl: string;
let errorALanzar: unknown = null;

const serviceStub = {
  loginGuardia: async () => {
    if (errorALanzar) throw errorALanzar;
    return SESION_VALIDA;
  },
} as unknown as AuthService;

function postLogin(body: unknown) {
  return fetch(`${baseUrl}/api/mobile/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/mobile/auth', buildMobileAuthRouter(serviceStub, {} as TokenService));
  app.use(errorHandler);

  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  errorALanzar = null;
});

describe('POST /api/mobile/auth/login — status codes', () => {
  it('responde 200 con la sesión cuando las credenciales son correctas', async () => {
    const res = await postLogin({ usuario: 'guardia1', password: 'Clave1!' });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ data: SESION_VALIDA });
  });

  it('responde 400 (no 401) si las credenciales son inválidas', async () => {
    // Este es el caso que rompía al guardia: la app leía cualquier 401 como
    // "sesión expiró" e ignoraba el mensaje real del backend.
    errorALanzar = Errors.invalidCredentials();

    const res = await postLogin({ usuario: 'guardia1', password: 'mala' });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('INVALID_CREDENTIALS');
    expect(body.error.message).toBe('Credenciales inválidas.');
  });

  it('deja el 401 intacto cuando el error NO es de credenciales', async () => {
    // El 401 de sesión vencida es correcto y el refresh automático depende de él:
    // no debe remapearse.
    errorALanzar = Errors.auth();

    const res = await postLogin({ usuario: 'guardia1', password: 'Clave1!' });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: 'UNAUTHORIZED' },
    });
  });
});

describe('POST /api/mobile/auth/login — errores que no tocan el status', () => {
  it('deja 403 cuando la cuenta está deshabilitada', async () => {
    errorALanzar = Errors.accountDisabled();

    const res = await postLogin({ usuario: 'guardia1', password: 'Clave1!' });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: 'ACCOUNT_DISABLED' },
    });
  });

  it('responde 400 VALIDATION_ERROR si falta la contraseña', async () => {
    const res = await postLogin({ usuario: 'guardia1' });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_ERROR' },
    });
  });
});