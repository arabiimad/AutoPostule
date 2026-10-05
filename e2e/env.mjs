/** Variables d'environnement du serveur pendant les tests : toutes les sources pointent vers le faux serveur. */
export const MOCK_PORT = Number(process.env.MOCK_PORT) || 4011;
export const APP_PORT = Number(process.env.E2E_PORT) || 3107;

export function e2eServerEnv() {
  const m = `http://localhost:${MOCK_PORT}`;
  return {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(APP_PORT),
    AUTH_MODE: 'off',
    GEMINI_API_KEY: 'e2e',
    GEMINI_API_BASE_URL: m,
    LBA_API_KEY: 'e2e', FT_CLIENT_ID: 'e2e', FT_CLIENT_SECRET: 'e2e', JSEARCH_API_KEY: 'e2e', ADZUNA_APP_ID: 'e2e', ADZUNA_APP_KEY: 'e2e', JOOBLE_API_KEY: 'e2e',
    UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
    ATS_SOURCES: 'off',
    GEO_API_URL: `${m}/geo`,
    LBA_API_BASE: `${m}/lba`,
    LBA_ROME_URL: `${m}/rome`,
    FT_TOKEN_URL: `${m}/ft/token`,
    FT_SEARCH_URL: `${m}/ft/search`,
    JSEARCH_API_URL: `${m}/rapidapi/search`,
    ADZUNA_API_URL: `${m}/adz/search/1`,
    JOOBLE_HOST: `${m}/jbl`
  };
}
