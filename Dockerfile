# AutoPostule — image de production (serveur Node + Chromium pour les PDF Web)
# docker build -t autopostule . && docker run -p 3000:3000 --env-file .env autopostule
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Variables VITE_* lues au build (Supabase, Sentry, PostHog) : --build-arg ou fichier .env
ARG VITE_SUPABASE_URL VITE_SUPABASE_ANON_KEY VITE_SENTRY_DSN VITE_POSTHOG_KEY VITE_PREMIUM_PRICE VITE_AUTH_GOOGLE
RUN npm run build && npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/build ./build
COPY --from=build /app/package.json ./
USER pwuser
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "build/server/server.cjs"]
