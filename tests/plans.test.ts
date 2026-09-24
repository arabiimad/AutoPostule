import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';

for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'UPSTASH_REDIS_REST_URL', 'QUOTAS']) delete process.env[k];
process.env.QUOTA_FREE_CV = '2';

const { requireQuota, planLimits, currentPeriod } = await import('../server/plans.ts');
const { verifyStripeSignature, formEncode } = await import('../server/stripe.ts');

let server: Server;
let base = '';
before(async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.post('/ia', requireQuota('cv'), (req: any, res) => res.json({ plan: req.plan }));
  app.post('/sans-ia', requireQuota('cv'), (_req, res) => { res.locals.noCharge = true; res.json({ ok: true }); });
  app.post('/erreur', requireQuota('cv'), (_req, res) => res.status(500).json({}));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server.close());

const call = (p: string, ip: string) => fetch(base + p, { method: 'POST', headers: { 'X-Forwarded-For': ip } });
const tick = () => new Promise((r) => setTimeout(r, 30));

test('quota gratuit : 2 CV puis 402 QUOTA_EXCEEDED (compteur par visiteur)', async () => {
  assert.equal((await (await call('/ia', '10.0.0.1')).json()).plan, 'free');
  await tick();
  assert.equal((await call('/ia', '10.0.0.1')).status, 200);
  await tick();
  const r = await call('/ia', '10.0.0.1');
  assert.equal(r.status, 402);
  const body = await r.json();
  assert.equal(body.error, 'QUOTA_EXCEEDED');
  assert.equal(body.limit, 2);
  assert.match(body.message, /Premium/);
  // Un autre visiteur a son propre compteur
  assert.equal((await call('/ia', '10.0.0.2')).status, 200);
});

test('non décompté : réponse sans IA (repli) ou en erreur', async () => {
  for (let i = 0; i < 4; i++) { await call('/sans-ia', '10.0.0.3'); await call('/erreur', '10.0.0.3'); await tick(); }
  assert.equal((await call('/ia', '10.0.0.3')).status, 200);
});

test('QUOTAS=off : aucune limite', async () => {
  process.env.QUOTAS = 'off';
  for (let i = 0; i < 5; i++) assert.equal((await call('/ia', '10.0.0.4')).status, 200);
  delete process.env.QUOTAS;
});

test('forfaits : Premium bien au-dessus du gratuit ; période AAAA-MM', () => {
  const free = planLimits('free'), premium = planLimits('premium');
  for (const k of Object.keys(free) as (keyof typeof free)[]) assert.ok(premium[k] > free[k], k);
  assert.match(currentPeriod(new Date('2026-09-24')), /^2026-09$/);
});

test('Stripe : signature du webhook vérifiée (valide, falsifiée, trop ancienne)', () => {
  const secret = 'whsec_test';
  const payload = '{"type":"checkout.session.completed"}';
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  assert.equal(verifyStripeSignature(payload, `t=${t},v1=${sig}`, secret), true);
  assert.equal(verifyStripeSignature(payload + ' ', `t=${t},v1=${sig}`, secret), false);
  assert.equal(verifyStripeSignature(payload, `t=${t},v1=${sig}`, 'autre'), false);
  assert.equal(verifyStripeSignature(payload, `t=${t - 3600},v1=${createHmac('sha256', secret).update(`${t - 3600}.${payload}`).digest('hex')}`, secret), false);
  assert.equal(verifyStripeSignature(payload, '', secret), false);
});

test('Stripe : encodage des paramètres imbriqués', () => {
  assert.equal(
    formEncode({ mode: 'subscription', line_items: [{ price: 'price_1', quantity: 1 }], metadata: { uid: 'a b' } }),
    'mode=subscription&line_items%5B0%5D%5Bprice%5D=price_1&line_items%5B0%5D%5Bquantity%5D=1&metadata%5Buid%5D=a%20b'
  );
});
