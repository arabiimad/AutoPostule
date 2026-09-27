// Variables d'environnement chargées avant tout autre module (les modèles IA lisent process.env au chargement)
import "dotenv/config";
import express from "express";
import path from "path";
import { createApp } from "./server/app.ts";
import { closeWebPdf } from "./server/pdf.ts";
import { kv } from "./server/store.ts";
import { getSourceStatus } from "./server/jobSources.ts";
import { logEvent } from "./server/log.ts";
import { initMonitoring, flushMonitoring } from "./server/monitoring.ts";

// Port fourni par l'hébergeur (Cloud Run, Render…) ; 3000 en local
const PORT = Number(process.env.PORT) || 3000;

async function startServer() {
  await initMonitoring();
  const app = createApp();

  // Production : NODE_ENV=production, ou serveur lancé depuis le bundle (npm start → build/server/server.cjs)
  const isProduction = process.env.NODE_ENV === "production" || /server\.cjs$/.test(process.argv[1] || "");
  if (!isProduction) {
    // Import dynamique : Vite n'est chargé qu'en développement
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const httpServer = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    logEvent("info", "server_started", { port: PORT, mode: isProduction ? "production" : "development", storage: kv().kind, sources: getSourceStatus() });
  });

  // Arrêt propre (déploiement, Ctrl+C) : ferme Chromium et les connexions, puis quitte
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logEvent("info", "server_stopping", { signal });
    setTimeout(() => process.exit(0), 5000).unref();
    httpServer.close();
    httpServer.closeAllConnections?.();
    Promise.allSettled([closeWebPdf(), flushMonitoring()]).finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

startServer();
