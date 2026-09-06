// Entorno de test: valores mínimos en caso de no existir .env (dotenv no
// sobrescribe lo ya definido).

process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:5432/gamc_seguridad';
process.env.JWT_SECRET ??= 'test-llave-de-firma-de-32-caracteres-minimo';
process.env.DEV_RETURN_RESET_CODE ??= 'true';