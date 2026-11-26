import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

const send = vi.fn();

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send })),
  GetObjectCommand: vi.fn((input: unknown) => ({ input })),
  PutObjectCommand: vi.fn((input: unknown) => ({ input })),
}));

describe('GET /media/:clave con RustFS', () => {
  let servidor: Server;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.S3_ENDPOINT = 'http://rustfs:9000';
    process.env.S3_REGION = 'us-east-1';
    process.env.S3_ACCESS_KEY_ID = 'clave-rustfs';
    process.env.S3_SECRET_ACCESS_KEY = 'secreto-rustfs';
    process.env.S3_BUCKET = 'gamc-media';
    process.env.S3_FORCE_PATH_STYLE = 'true';
    vi.resetModules();

    const { buildMediaPublicRouter } = await import('../media.routes.js');
    const { errorHandler } = await import('@shared/errors');
    const app = express();
    app.use('/media', buildMediaPublicRouter());
    app.use(errorHandler);
    servidor = await new Promise<Server>((resolver) => {
      const s = app.listen(0, '127.0.0.1', () => resolver(s));
    });
    const direccion = servidor.address();
    if (!direccion || typeof direccion === 'string') throw new Error('No se pudo iniciar el servidor de pruebas.');
    baseUrl = `http://127.0.0.1:${direccion.port}`;
  });

  afterAll(async () => {
    if (servidor) await new Promise<void>((resolver, rechazar) => servidor.close((e) => (e ? rechazar(e) : resolver())));
    for (const clave of [
      'S3_ENDPOINT', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_BUCKET', 'S3_FORCE_PATH_STYLE',
    ]) delete process.env[clave];
  });

  beforeEach(() => send.mockReset());

  it('sirve el objeto del bucket con cabeceras de caché inmutable', async () => {
    send.mockResolvedValueOnce({
      Body: { transformToByteArray: async () => new Uint8Array([80, 78, 71]) },
      ContentType: 'image/png',
    });

    const res = await fetch(`${baseUrl}/media/fotos/11111111-1111-4111-8111-111111111111.png`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from([80, 78, 71]));
  });

  it('responde 404 cuando el objeto no existe en el bucket', async () => {
    send.mockRejectedValueOnce(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }));

    const res = await fetch(`${baseUrl}/media/fotos/11111111-1111-4111-8111-111111111111.png`);

    expect(res.status).toBe(404);
  });

  it('responde 404 para una clave que no corresponde a una evidencia', async () => {
    const res = await fetch(`${baseUrl}/media/config/secreto.png`);

    expect(res.status).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });
});
