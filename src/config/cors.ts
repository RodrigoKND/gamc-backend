import type { CorsOptions } from 'cors';
import { env } from './env.js';

// CORS por lista blanca explícita (RF "pro"): el backend rechaza cualquier
// Origin que no esté en CORS_ORIGINS. NUNCA "*" con credenciales.
// Los métodos se acotan a los verbos reales y los headers a los que la web
// necesita. Con credentials:true (cookies httpOnly de sesión) ES obligatorio
// listar orígenes — verificar exactamente los del entorno.

export const corsOptions: CorsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true); // peticiones server-to-server
    if (env.CORS_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error(`Origen no autorizado por CORS: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-csrf-token'],
  maxAge: 600,
};