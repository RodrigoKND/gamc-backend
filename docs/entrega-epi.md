# Entrega EPI

Crear, asignar y cancelar rutas exige permiso por rol y EPI asignada.
Super_admin queda exento del límite territorial. El control por EPI no está
generalizado a guardias, hechos o usuarios: sus ediciones mantienen permisos
por rol. No presentar esta entrega como aislamiento de toda la información.

Las cinco zonas son aproximadas. Sud agrupa Sur, Jaihuayco y Alalay Sud.
El inventario contiene ubicaciones, no límites administrativos oficiales.
Validar los polígonos antes de utilizarlos para operación real.

## Despliegue

1. Configurar DATABASE_URL, JWT_SECRET, NODE_ENV=production,
   COOKIE_SECURE=true, DEV_RETURN_RESET_CODE=false y CORS_ORIGINS con los
   dominios HTTPS autorizados. JWT_SECRET debe coincidir con el frontend.
2. Ejecutar npm ci (incluye prisma generate).
3. Respaldar la base y ejecutar npx prisma migrate deploy: requiere 0004 y 0005.
4. Ejecutar npm run build y npm start.
5. Asignar EPI a las cuentas existentes mediante administración autorizada.
6. Publicar el frontend compatible y verificar login, jurisdicción y rechazo
   de escrituras de rutas fuera de la EPI.

No ejecutar el seed de demostración en producción. compose.yaml es para uso
local: PostgreSQL ligado a 127.0.0.1 y credenciales de desarrollo.

07_rutas_backfill_epi.sql es opcional: elige la EPI mayoritaria de las patrullas
para plantillas sin EPI. Revisar manualmente rutas mixtas antes de aplicarlo.

Se eliminó el log de contraseña/hash; los logs HTTP ocultan tokens y cookies.
La recuperación nunca devuelve el código en NODE_ENV=production.
Build, TypeScript y pruebas del backend forman parte de la verificación.
