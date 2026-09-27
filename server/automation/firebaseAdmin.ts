/**
 * Application firebase-admin partagée (Firestore, Cloud Messaging).
 *
 * Identifiants : ceux de Google Cloud (compte de service de Cloud Run, ou GOOGLE_APPLICATION_CREDENTIALS
 * pointant vers le fichier JSON d'un compte de service). Base Firestore : FIRESTORE_DATABASE_ID,
 * sinon firestoreDatabaseId de firebase-applet-config.json.
 */
import fs from "fs";
import path from "path";

function appletConfig(): any {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), "firebase-applet-config.json"), "utf8"));
  } catch {
    return {};
  }
}

export async function adminApp() {
  const appMod = await import("firebase-admin/app");
  if (appMod.getApps().length) return appMod.getApp();
  const projectId = process.env.FIREBASE_PROJECT_ID || appletConfig().projectId;
  return appMod.initializeApp(projectId ? { projectId } : {});
}

export async function adminFirestore() {
  const { getFirestore } = await import("firebase-admin/firestore");
  const databaseId = process.env.FIRESTORE_DATABASE_ID || appletConfig().firestoreDatabaseId;
  const app = await adminApp();
  return databaseId && databaseId !== "(default)" ? getFirestore(app, databaseId) : getFirestore(app);
}
