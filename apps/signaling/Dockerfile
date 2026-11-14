# Contexte de build : la racine du dépôt (le serveur importe packages/protocol).
FROM node:24-alpine AS build
WORKDIR /app
COPY . .
RUN npm ci --workspace @binome/signaling --include-workspace-root --ignore-scripts
RUN npm run build -w @binome/signaling

# Le bundle contient tout, y compris ws : pas de node_modules à l'exécution.
FROM node:24-alpine
WORKDIR /app
COPY --from=build /app/apps/signaling/dist/index.js ./index.js
ENV NODE_ENV=production
USER node
CMD ["node", "index.js"]
