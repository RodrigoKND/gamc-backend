import { z } from 'zod';

// Contratos de entrada del API de auth. `PasswordPolicy` es la ÚNICA
// definición de fortaleza de contraseña (la reutiliza el frontend).

export const PasswordPolicy = {
  regex: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^\w\s]).{8,72}$/,
  message: 'Mínimo 8 caracteres, con mayúscula, minúscula, número y símbolo.',
} as const;

export const passwordSchema = z
  .string()
  .max(72)
  .regex(PasswordPolicy.regex, PasswordPolicy.message);

export const loginSchema = z.object({
  identifier: z.string().trim().min(3).max(120),
  password: z.string().min(1).max(200),
});

export const requestRecoverySchema = z.object({
  identifier: z.string().trim().min(3).max(120),
});

export const recoveryCodeSchema = z.string().regex(/^\d{6}$/, 'El código tiene 6 dígitos.');

export const confirmRecoverySchema = z.object({
  identifier: z.string().trim().min(3).max(120),
  code: recoveryCodeSchema,
  newPassword: passwordSchema,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});