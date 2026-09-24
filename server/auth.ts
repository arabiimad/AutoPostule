/**
 * Vérification des utilisateurs Firebase côté serveur.
 *
 * AUTH_MODE (variable d'environnement) :
 *  - "off"      : aucune vérification (développement).
 *  - "optional" : (défaut) le jeton est vérifié s'il est présent ; la limite de débit se fait alors par compte.
 *  - "required" : les routes IA exigent un compte Firebase connecté (les sessions locales n'y ont plus accès).
 *
 * La vérification n'a besoin que de l'identifiant du projet (pas de compte de service) :
 * firebase-admin télécharge les certificats publics de Google pour valider la signature du jeton.
 */
import fs from "fs";
import path from "path";

type Verifier = (token: string) => Promise<{ uid: string }>;

let verifierPromise: Promise<Verifier | null> | null = null;

function readProjectId(): string | undefined {
  if (process.env.FIREBASE_PROJECT_ID) return process.env.FIREBASE_PROJECT_ID;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "firebase-applet-config.json"), "utf8"));
    return cfg.projectId;
  } catch {
    return undefined;
  }
}

async function loadVerifier(): Promise<Verifier | null> {
  try {
    const appMod: any = await import("firebase-admin/app");
    const authMod: any = await import("firebase-admin/auth");
    const projectId = readProjectId();
    const app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp({ projectId });
    const auth = authMod.getAuth(app);
    return async (token: string) => {
      const decoded = await auth.verifyIdToken(token);
      return { uid: decoded.uid };
    };
  } catch (e: any) {
    console.warn("[Auth] firebase-admin indisponible (lancez « npm install ») :", e?.message || e);
    return null;
  }
}

export function getAuthMode(): "off" | "optional" | "required" {
  const m = String(process.env.AUTH_MODE || "optional").toLowerCase();
  return m === "off" || m === "required" ? m : "optional";
}

/** Middleware Express : renseigne req.uid si un jeton valide est fourni. */
export function authMiddleware() {
  const mode = getAuthMode();
  return async (req: any, res: any, next: any) => {
    if (mode === "off") return next();
    const header = String(req.headers.authorization || "");
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

    if (!token) {
      if (mode === "required") {
        return res.status(401).json({ success: false, error: "Connexion requise : connectez-vous avec votre compte pour utiliser cette fonction." });
      }
      return next();
    }

    verifierPromise ||= loadVerifier();
    const verify = await verifierPromise;
    if (!verify) {
      if (mode === "required") {
        return res.status(503).json({ success: false, error: "Vérification des comptes indisponible sur le serveur." });
      }
      return next();
    }
    try {
      const { uid } = await verify(token);
      req.uid = uid;
      return next();
    } catch {
      return res.status(401).json({ success: false, error: "Session expirée : reconnectez-vous." });
    }
  };
}
