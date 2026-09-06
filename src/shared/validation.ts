import type { z, AnyZodObject } from 'zod';
import { Errors } from '@shared/errors';

// ValidaciÃ³n de DTOs con zod, reutilizable en controllers y middlewares.
// `validate` lanza un AppError de validaciÃ³n con el detalle de cada campo,
// para que la vista pueda mostrar errores inline por input.

export type InferZod<TSchema extends AnyZodObject> = z.infer<TSchema>;

export function validate<TSchema extends AnyZodObject>(
  schema: TSchema,
  data: unknown,
): z.infer<TSchema> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    throw Errors.validation('Datos de entrada invÃ¡lidos.', issues);
  }
  return result.data;
}
