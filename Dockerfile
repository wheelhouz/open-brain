## Stage 1: Build frontend
FROM node:22-alpine AS web-build
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/ ./
RUN npm run build

## Stage 2: Build backend
FROM node:22-alpine AS app-build
WORKDIR /app
COPY app/package.json app/package-lock.json* ./
RUN npm install --production=false
COPY app/tsconfig.json ./
COPY app/src/ ./src/
RUN npm run build

## Stage 3: Production
FROM node:22-alpine
WORKDIR /app
COPY app/package.json app/package-lock.json* ./
RUN npm install --omit=dev
COPY --from=app-build /app/dist ./dist
RUN rm -rf ./dist/__tests__
COPY --from=web-build /web/dist ./static
COPY db/init.sql ./init.sql
COPY db/migrations ./migrations

CMD ["node", "dist/index.js"]
