import type { z, AnyZodObject } from 'zod';
import { Errors } from '@shared/errors';

// Validación de DTOs con zod, reutilizable en controllers y middlewares.
// `validate` lanza un AppError de validación con el detalle de cada campo,
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
    throw Errors.validation('Datos de entrada inválidos.', issues);
  }
  return result.data;
}
