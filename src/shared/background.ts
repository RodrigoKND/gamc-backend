import { logger } from '@infra/logger';

// Trabajo que no condiciona la respuesta al cliente (auditoría, métricas de
// último acceso). Se dispara sin esperar y un fallo solo se registra: nunca
// debe convertir un login correcto en un error ni retrasarlo.
export function runInBackground(label: string, task: () => Promise<unknown>): void {
  void Promise.resolve()
    .then(task)
    .catch((err: unknown) => logger.warn({ err, label }, 'Tarea en segundo plano falló'));
}
