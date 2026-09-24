import type { Express } from "express";
import { logEvent } from "../log.ts";
import { getAuthMode } from "../auth.ts";
import { getSourceStatus } from "../jobSources.ts";
import { kv } from "../store.ts";
import { detectLatexCompiler } from "../latex.ts";

export function registerSystemRoutes(app: Express) {
  // Erreurs JavaScript remontées par le navigateur (suivi d'erreurs sans service tiers)
  app.post("/api/client-errors", (req, res) => {
    const b = req.body || {};
    logEvent("error", "client_error", {
      message: String(b.message || "").slice(0, 500),
      stack: String(b.stack || "").slice(0, 2000),
      url: String(b.url || "").slice(0, 300),
      userAgent: String(req.headers["user-agent"] || "").slice(0, 200),
      release: String(b.release || "")
    });
    res.status(204).end();
  });

  app.get("/api/health", async (req, res) => {
    res.json({
      status: "ok",
      ai: !!process.env.GEMINI_API_KEY,
      authMode: getAuthMode(),
      jobSources: getSourceStatus(),
      storage: kv().kind,
      latexCompiler: !!(await detectLatexCompiler())
    });
  });
}
