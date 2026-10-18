import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send })),
  PutObjectCommand: vi.fn((input) => ({ input })),
}));

describe('guardarArchivo con Cloudflare R2', () => {
  beforeEach(() => {
    vi.resetModules();
    send.mockReset();
    Object.assign(process.env, {
      R2_ACCOUNT_ID: 'cuenta',
      R2_ACCESS_KEY_ID: 'clave',
      R2_SECRET_ACCESS_KEY: 'secreto',
      R2_BUCKET: 'gamc-media',
      R2_PUBLIC_URL: 'https://media.gamc.bo/',
    });
  });

  it('sube al bucket y devuelve la URL pública del archivo', async () => {
    const { guardarArchivo } = await import('../media.storage.js');
    const r = await guardarArchivo({ mimetype: 'video/mp4', buffer: Buffer.from('x') } as Express.Multer.File, 'http://localhost:4000');

    expect(send).toHaveBeenCalledTimes(1);
    const { input } = send.mock.calls[0]![0];
    expect(input).toMatchObject({ Bucket: 'gamc-media', ContentType: 'video/mp4' });
    expect(input.Key).toMatch(/^videos\/[0-9a-f-]{36}\.mp4$/);
    expect(r).toEqual({ url: `https://media.gamc.bo/${input.Key}`, tipo: 'video' });
  });
});
