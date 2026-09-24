import { getAccessToken } from '../data/cloud';

/**
 * fetch vers l'API du serveur, avec le jeton de session de l'utilisateur connecté
 * (le serveur l'utilise pour vérifier le compte et limiter le débit par compte).
 */
export async function apiFetch(path: string, body?: unknown, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> || {}) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    const token = await getAccessToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  } catch {
    // pas de jeton disponible (session locale / hors ligne) : requête anonyme
  }
  return fetch(path, {
    method: body !== undefined ? 'POST' : 'GET',
    ...init,
    headers,
    body: body !== undefined ? JSON.stringify(body) : init.body
  });
}

/** Lit la réponse JSON, ou lève une erreur lisible. */
export async function readJson<T = any>(res: Response): Promise<T> {
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error((data && (data.message || data.error)) || `Erreur serveur (${res.status})`);
  }
  return data as T;
}
