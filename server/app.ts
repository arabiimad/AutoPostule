import express, { type Express } from "express";
import { authMiddleware } from "./auth.ts";
import { createRateLimiter } from "./rateLimit.ts";
import { logEvent } from "./log.ts";
import { captureError } from "./monitoring.ts";
import { withoutPhoto } from "./latex.ts";
import { registerSystemRoutes } from "./routes/system.ts";
import { registerCvRoutes } from "./routes/cv.ts";
import { registerJobRoutes } from "./routes/jobs.ts";
import { registerTailorRoutes } from "./routes/tailor.ts";
import { registerLatexRoutes } from "./routes/latex.ts";
import { registerInterviewRoutes } from "./routes/interview.ts";
import { registerAccountRoutes, registerAccountApiRoutes } from "./routes/account.ts";

/** Application Express (API seulement) : utilisée par server.ts et par les tests. */
export function createApp(): Express {
  const app = express();
  // Un seul proxy devant l'application (Cloud Run / AI Studio) : req.ip = vraie IP du client
  app.set("trust proxy", 1);
  // Webhook Stripe avant le décodage JSON (signature calculée sur le corps brut)
  registerAccountRoutes(app);
  app.use(express.json({ limit: "12mb" }));
  app.use(express.urlencoded({ extended: true, limit: "12mb" }));

  // Vérification du compte (AUTH_MODE) puis limite de débit : 30 appels IA / minute par compte ou par IP
  const PROTECTED = ["/api/cv", "/api/tailor", "/api/interview", "/api/latex/compile"];
  // /api/cv/html et /api/cv/pdf : rendu sans IA → même limite large que /api/tailor/render
  app.use(PROTECTED, authMiddleware());
  // Compte et abonnement : identification seulement (pas de limite IA)
  app.use(["/api/account", "/api/billing/checkout", "/api/billing/portal"], authMiddleware());
  app.use(["/api/account", "/api/billing"], createRateLimiter("account", 60, 60_000));
  // Mise en forme sans IA (/api/tailor/render) : appelée à chaque retouche, limite plus large
  const iaLimiter = createRateLimiter("ia", 30, 60_000);
  const renderLimiter = createRateLimiter("render", 150, 60_000);
  app.use(PROTECTED, (req: any, res: any, next: any) =>
    (/^\/api\/(tailor\/render|cv\/html|cv\/pdf)/.test(String(req.originalUrl)) ? renderLimiter : iaLimiter)(req, res, next));
  // Recherche d'offres : quotas des API partenaires (60/min pour La bonne alternance), résultats en cache
  app.use("/api/jobs", createRateLimiter("jobs", 40, 60_000));
  app.use("/api/client-errors", createRateLimiter("errors", 20, 60_000));
  // La photo du profil ne sert qu'à la mise en page : retirée avant tout traitement (IA, garde-fous, journaux)
  app.use(["/api/tailor", "/api/interview"], (req: any, _res: any, next: any) => {
    if (req.body?.candidate) req.body.candidate = withoutPhoto(req.body.candidate);
    next();
  });

  registerSystemRoutes(app);
  registerCvRoutes(app);
  registerJobRoutes(app);
  registerTailorRoutes(app);
  registerLatexRoutes(app);
  registerInterviewRoutes(app);
  registerAccountApiRoutes(app);

  // Erreurs non gérées sur /api
  app.use("/api", (err: any, req: any, res: any, next: any) => {
    logEvent("error", "api_unhandled", { path: req.path, message: String(err?.message || err) });
    if (err?.type !== "entity.too.large") captureError(err, { path: req.path });
    if (res.headersSent) return next(err);
    const status = err.type === "entity.too.large" ? 413 : (err.status || 500);
    return res.status(status).json({
      success: false,
      // Jamais de message technique à l'écran : le détail est dans le journal ci-dessus
      error: status === 413 ? "Fichier trop volumineux (12 Mo maximum)." : status < 500 ? "Requête invalide : rechargez la page puis réessayez." : "Une erreur est survenue. Réessayez dans un instant."
    });
  });

  return app;
}
