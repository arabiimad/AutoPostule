import { initializeApp, getApps, getApp } from 'firebase/app';
import { initializeFirestore } from 'firebase/firestore';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import firebaseConfig from '../firebase-applet-config.json';

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// ignoreUndefinedProperties : sans cette option, un seul champ `undefined`
// (ex. détail de formation vide) faisait échouer toute la sauvegarde du profil.
export const db = initializeFirestore(
  app,
  { ignoreUndefinedProperties: true },
  firebaseConfig.firestoreDatabaseId || undefined
);

export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
