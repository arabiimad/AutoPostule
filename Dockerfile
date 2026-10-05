# Image de production d'AutoPostule : interface (Vite) + serveur Express.
# Base Playwright : Chromium et ses dépendances sont fournis (export PDF du CV).
# La version doit suivre celle du paquet « playwright » de package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    ATS_INDEX_FILE=/app/.cache/career-index.json
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Configuration Firebase publique (vérification des comptes côté serveur)
COPY --from=build /app/firebase-applet-config.json ./
# Index des sites carrières : monter un disque persistant ici pour le garder entre deux déploiements
RUN mkdir -p /app/.cache && chown -R pwuser:pwuser /app/.cache
USER pwuser
EXPOSE 3000
CMD ["node", "dist/server.cjs"]
