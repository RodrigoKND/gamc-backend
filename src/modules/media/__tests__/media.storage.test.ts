import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const send = vi.fn();

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send })),
  PutObjectCommand: vi.fn((input: unknown) => ({ input })),
  GetObjectCommand: vi.fn((input: unknown) => ({ input })),
  DeleteObjectCommand: vi.fn((input: unknown) => ({ input })),
}));

const VARS_S3 = [
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_BUCKET',
  'S3_FORCE_PATH_STYLE',
] as const;

const VARS_R2 = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'R2_PUBLIC_URL',
] as const;

function limpiarVariables(): void {
  for (const clave of [...VARS_S3, ...VARS_R2]) delete process.env[clave];
}

function configurarR2(): void {
  process.env.R2_ACCOUNT_ID = 'cuenta';
  process.env.R2_ACCESS_KEY_ID = 'clave';
  process.env.R2_SECRET_ACCESS_KEY = 'secreto';
  process.env.R2_BUCKET = 'gamc-media';
  process.env.R2_PUBLIC_URL = 'https://media.gamc.bo/';
}

function configurarRustFS(): void {
  process.env.S3_ENDPOINT = 'http://rustfs:9000';
  process.env.S3_REGION = 'us-east-1';
  process.env.S3_ACCESS_KEY_ID = 'clave-rustfs';
  process.env.S3_SECRET_ACCESS_KEY = 'secreto-rustfs';
  process.env.S3_BUCKET = 'gamc-media';
  process.env.S3_FORCE_PATH_STYLE = 'true';
}

const archivoFoto = { mimetype: 'image/png', buffer: Buffer.from('png') } as Express.Multer.File;

describe('guardarArchivo con almacenamiento remoto', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    send.mockReset();
    limpiarVariables();
  });

  it('sube al bucket y devuelve la URL pública del archivo (compatibilidad R2)', async () => {
    configurarR2();
    const { guardarArchivo } = await import('../media.storage.js');

    const resultado = await guardarArchivo({ ...archivoFoto, mimetype: 'video/mp4' }, 'http://localhost:4000');

    const entrada = vi.mocked(PutObjectCommand).mock.calls[0]![0] as { Bucket: string; Key: string; ContentType: string };
    const opciones = vi.mocked(S3Client).mock.calls[0]![0];
    expect(entrada.Bucket).toBe('gamc-media');
    expect(entrada.ContentType).toBe('video/mp4');
    expect(entrada.Key).toMatch(/^videos\/[0-9a-f-]{36}\.mp4$/);
    expect(opciones).toMatchObject({
      region: 'auto',
      endpoint: 'https://cuenta.r2.cloudflarestorage.com',
      forcePathStyle: false,
      credentials: { accessKeyId: 'clave', secretAccessKey: 'secreto' },
    });
    expect(resultado).toEqual({ url: `https://media.gamc.bo/${entrada.Key}`, tipo: 'video' });
  });

  it('guarda en RustFS y devuelve una URL servida por el propio API', async () => {
    configurarRustFS();
    const { guardarArchivo } = await import('../media.storage.js');

    const resultado = await guardarArchivo(archivoFoto, 'https://gamc.example.com');

    const entrada = vi.mocked(PutObjectCommand).mock.calls[0]![0] as { Bucket: string; Key: string };
    const opciones = vi.mocked(S3Client).mock.calls[0]![0];
    expect(entrada.Bucket).toBe('gamc-media');
    expect(entrada.Key).toMatch(/^fotos\/[0-9a-f-]{36}\.png$/);
    expect(opciones).toMatchObject({
      region: 'us-east-1',
      endpoint: 'http://rustfs:9000',
      forcePathStyle: true,
      credentials: { accessKeyId: 'clave-rustfs', secretAccessKey: 'secreto-rustfs' },
    });
    expect(resultado).toEqual({ url: `https://gamc.example.com/media/${entrada.Key}`, tipo: 'foto' });
  });
});

describe('descargarArchivo desde RustFS', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    send.mockReset();
    limpiarVariables();
    configurarRustFS();
  });

  it('devuelve el contenido y el tipo del objeto indicado', async () => {
    send.mockResolvedValueOnce({
      Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
      ContentType: 'image/png',
    });
    const { descargarArchivo } = await import('../media.storage.js');
    const clave = 'fotos/11111111-1111-4111-8111-111111111111.png';

    const resultado = await descargarArchivo(clave);

    expect(vi.mocked(GetObjectCommand).mock.calls[0]![0]).toEqual({ Bucket: 'gamc-media', Key: clave });
    expect(Buffer.from(resultado.bytes)).toEqual(Buffer.from([1, 2, 3]));
    expect(resultado.contentType).toBe('image/png');
  });

  it('rechaza claves que no sean rutas de evidencia generadas por el servidor', async () => {
    const { descargarArchivo } = await import('../media.storage.js');

    await expect(descargarArchivo('../config/secreto.png')).rejects.toMatchObject({ status: 404 });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('eliminarArchivo de evidencias', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    send.mockReset();
    limpiarVariables();
    configurarRustFS();
  });

  it('borra en RustFS el objeto indicado por una URL /media válida', async () => {
    const { eliminarArchivo } = await import('../media.storage.js');

    await eliminarArchivo('http://localhost:8080/media/fotos/11111111-1111-4111-8111-111111111111.png');

    expect(vi.mocked(DeleteObjectCommand).mock.calls[0]![0]).toEqual({
      Bucket: 'gamc-media',
      Key: 'fotos/11111111-1111-4111-8111-111111111111.png',
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('no hace llamadas a Cloudflare ni a Supabase para URLs ajenas al API', async () => {
    const { eliminarArchivo } = await import('../media.storage.js');

    await eliminarArchivo('https://media.gamc.bo/fotos/11111111-1111-4111-8111-111111111111.png');
    await eliminarArchivo('https://iiaclymiuyvshzotfche.supabase.co/storage/v1/object/evidencias/selfies/x.png');

    expect(send).not.toHaveBeenCalled();
    expect(DeleteObjectCommand).not.toHaveBeenCalled();
  });

  it('trata un objeto ya borrado como eliminación correcta', async () => {
    send.mockRejectedValueOnce(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }));
    const { eliminarArchivo } = await import('../media.storage.js');

    await expect(
      eliminarArchivo('http://localhost:8080/media/videos/22222222-2222-4222-8222-222222222222.mp4'),
    ).resolves.toBeUndefined();
  });
});
