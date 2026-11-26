# API GAMC — imagen de producción (Node 20 + Prisma).
# Build multi-etapa: las dependencias de desarrollo no llegan a la imagen final.

FROM node:20-bookworm-slim AS build
WORKDIR /app

# `npm ci` ejecuta el postinstall (prisma generate), por eso el schema va antes.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# El proceso no necesita root: solo escucha un puerto y escribe logs en stdout.
RUN useradd --create-home --uid 10001 appuser && mkdir -p uploads && chown appuser:appuser uploads
USER appuser

EXPOSE 4000
CMD ["node", "dist/server.js"]
