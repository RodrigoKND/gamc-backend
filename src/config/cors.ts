import type { CorsOptions } from 'cors';
import { env } from './env.js';

// CORS por lista blanca explícita (RF "pro"): el backend rechaza cualquier
// Origin que no esté en CORS_ORIGINS. NUNCA "*" con credenciales.
// Los métodos se acotan a los verbos reales y los headers a los que la web
// necesita. Con credentials:true (cookies httpOnly de sesión) ES obligatorio
// listar orígenes — verificar exactamente los del entorno.

export const corsOptions: CorsOptions = {
  origin(origin, callback) {
    // Sin Origin: apps nativas (React Native / Expo Go) y llamadas
    // server-to-server. No hay cookie ambiente que proteger → se permite.
    if (!origin) return callback(null, true);
    if (env.CORS_ORIGINS.includes(origin)) return callback(null, true);
    // Expo web/dev sirve desde puertos y esquemas variables (exp://…, LAN).
    if (/^exp(o)?:\/\//.test(origin)) return callback(null, true);
    return callback(new Error(`Origen no autorizado por CORS: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  // `Authorization` habilita el Bearer de la app móvil en navegadores (Expo web).
  allowedHeaders: ['Content-Type', 'x-csrf-token', 'Authorization'],
  maxAge: 600,
};