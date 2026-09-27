/**
 * Facturation Stripe : faux Stripe + fausse API Supabase (aucun réseau), webhooks signés comme en production.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';

// --- Faux Stripe + fausse base -------------------------------------------------------------------------
const stripeSubs = new Map<string, any>();
const rows = new Map<string, any>();        // subscriptions par user_id
const events = new Set<string>();
const log: string[] = [];
let failStripeDelete = false;
const idem = new Map<string, any>();
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const u = new URL(req.url!, 'http://x');
    res.setHeader('Content-Type', 'application/json');
    const m = u.pathname.match(/^\/v1\/subscriptions\/(.+)$/);
    if (m && req.method === 'GET') return res.end(JSON.stringify(stripeSubs.get(m[1])));
    if (m && req.method === 'DELETE') {
      if (failStripeDelete) { res.statusCode = 500; return res.end('{"error":{"message":"panne"}}'); }
      log.push(`stripe:cancel:${m[1]}`);
      const s = stripeSubs.get(m[1]); if (s) s.status = 'canceled';
      return res.end(JSON.stringify(s || {}));
    }
    if (u.pathname === '/v1/checkout/sessions') {
      const key = String(req.headers['idempotency-key'] || '');
      if (key && idem.has(key)) return res.end(JSON.stringify(idem.get(key)));
      const s = { id: `cs_${idem.size + 1}`, url: `https://checkout.test/cs_${idem.size + 1}` };
      if (key) idem.set(key, s);
      log.push('stripe:checkout');
      return res.end(JSON.stringify(s));
    }
    if (u.pathname === '/rest/v1/subscriptions' && req.method === 'GET') {
      const uid = (u.searchParams.get('user_id') || '').replace('eq.', '');
      return res.end(JSON.stringify(rows.has(uid) ? [rows.get(uid)] : []));
    }
    if (u.pathname === '/rest/v1/subscriptions' && req.method === 'POST') {
      const r = JSON.parse(body); rows.set(r.user_id, { ...rows.get(r.user_id), ...r }); log.push(`db:upsert:${r.status}`);
      return res.end('');
    }
    if (u.pathname === '/rest/v1/stripe_events' && req.method === 'GET') {
      const id = (u.searchParams.get('id') || '').replace('eq.', '');
      return res.end(JSON.stringify(events.has(id) ? [{ id }] : []));
    }
    if (u.pathname === '/rest/v1/stripe_events' && req.method === 'POST') { events.add(JSON.parse(body).id); return res.end(''); }
    if (u.pathname.startsWith('/auth/v1/admin/users/') && req.method === 'DELETE') { log.push('auth:delete'); return res.end('{}'); }
    res.statusCode = 404; res.end('{}');
  });
});
await new Promise<void>((r) => mock.listen(0, r));
const M = `http://localhost:${(mock.address() as AddressInfo).port}`;
Object.assign(process.env, { STRIPE_API_URL: M, STRIPE_SECRET_KEY: 'sk_test', STRIPE_PRICE_PREMIUM: 'price_1', STRIPE_WEBHOOK_SECRET: 'whsec_test', SUPABASE_URL: M, SUPABASE_SERVICE_ROLE_KEY: 'srv', APP_URL: 'https://kareer.test' });
const { registerAccountRoutes, registerAccountApiRoutes } = await import('../server/routes/account.ts');

let server: http.Server;
let base = '';
before(async () => {
  const app = express();
  registerAccountRoutes(app);
  app.use(express.json());
  app.use((req: any, _res, next) => { req.uid = req.headers['x-uid']; req.email = 'k@test.fr'; next(); });
  registerAccountApiRoutes(app);
  await new Promise<void>((r) => { server = app.listen(0, r); });
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); mock.close(); });
beforeEach(() => { stripeSubs.clear(); rows.clear(); events.clear(); log.length = 0; failStripeDelete = false; idem.clear(); });

const U = 'user-1';
async function webhook(event: any) {
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', 'whsec_test').update(`${t}.${payload}`).digest('hex');
  return fetch(`${base}/api/billing/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` }, body: payload });
}
const sub = (id: string, status: string) => ({ id, status, customer: 'cus_1', metadata: { uid: U }, current_period_end: 1800000000 });

test('évènement reçu deux fois : traité une seule fois', async () => {
  stripeSubs.set('sub_1', sub('sub_1', 'active'));
  const ev = { id: 'evt_1', type: 'customer.subscription.created', data: { object: sub('sub_1', 'active') } };
  assert.equal((await webhook(ev)).status, 200);
  assert.equal((await webhook(ev)).status, 200);
  assert.equal(log.filter(l => l.startsWith('db:upsert')).length, 1);
  assert.equal(rows.get(U).plan, 'premium');
});

test('évènements dans le désordre : l’état actuel chez Stripe fait foi', async () => {
  stripeSubs.set('sub_1', sub('sub_1', 'active'));
  // Ancien évènement « incomplete » arrivé après l'activation
  await webhook({ id: 'evt_2', type: 'customer.subscription.updated', data: { object: sub('sub_1', 'incomplete') } });
  assert.equal(rows.get(U).status, 'active');
  assert.equal(rows.get(U).plan, 'premium');
});

test('impayé définitif : retour au forfait gratuit ; retard de paiement : Premium conservé', async () => {
  stripeSubs.set('sub_1', sub('sub_1', 'past_due'));
  await webhook({ id: 'evt_3', type: 'invoice.payment_failed', data: { object: { subscription: 'sub_1' } } });
  assert.equal(rows.get(U).plan, 'premium');
  stripeSubs.get('sub_1').status = 'unpaid';
  await webhook({ id: 'evt_4', type: 'customer.subscription.updated', data: { object: sub('sub_1', 'unpaid') } });
  assert.equal(rows.get(U).plan, 'free');
});

test('double paiement : le second abonnement actif est annulé automatiquement', async () => {
  stripeSubs.set('sub_1', sub('sub_1', 'active'));
  await webhook({ id: 'evt_5', type: 'customer.subscription.created', data: { object: sub('sub_1', 'active') } });
  stripeSubs.set('sub_2', sub('sub_2', 'active'));
  await webhook({ id: 'evt_6', type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_2', client_reference_id: U } } });
  assert.ok(log.includes('stripe:cancel:sub_2'));
  assert.equal(rows.get(U).stripe_subscription_id, 'sub_1');
});

test('résiliation tardive d’un ancien abonnement : le compte abonné n’est pas rétrogradé', async () => {
  rows.set(U, { user_id: U, plan: 'premium', status: 'active', stripe_subscription_id: 'sub_new', stripe_customer_id: 'cus_1' });
  stripeSubs.set('sub_old', sub('sub_old', 'canceled'));
  await webhook({ id: 'evt_7', type: 'customer.subscription.deleted', data: { object: sub('sub_old', 'canceled') } });
  assert.equal(rows.get(U).plan, 'premium');
  assert.equal(rows.get(U).stripe_subscription_id, 'sub_new');
});

test('paiement : refusé si déjà abonné ; double clic → même session', async () => {
  const pay = () => fetch(`${base}/api/billing/checkout`, { method: 'POST', headers: { 'x-uid': U, 'Content-Type': 'application/json' }, body: '{}' });
  const a = await (await pay()).json();
  const b = await (await pay()).json();
  assert.equal(a.url, b.url);
  assert.equal(log.filter(l => l === 'stripe:checkout').length, 1);
  rows.set(U, { user_id: U, plan: 'premium', status: 'active', stripe_subscription_id: 'sub_1' });
  assert.equal((await pay()).status, 409);
});

test('suppression d’un compte payant : abonnement résilié d’abord ; si Stripe échoue, rien n’est supprimé', async () => {
  rows.set(U, { user_id: U, plan: 'premium', status: 'active', stripe_subscription_id: 'sub_9' });
  stripeSubs.set('sub_9', sub('sub_9', 'active'));
  failStripeDelete = true;
  assert.equal((await fetch(`${base}/api/account`, { method: 'DELETE', headers: { 'x-uid': U } })).status, 502);
  assert.ok(!log.includes('auth:delete'));
  failStripeDelete = false;
  assert.equal((await fetch(`${base}/api/account`, { method: 'DELETE', headers: { 'x-uid': U } })).status, 200);
  assert.deepEqual(log.filter(l => l === 'stripe:cancel:sub_9' || l === 'auth:delete'), ['stripe:cancel:sub_9', 'auth:delete']);
});

test('signature invalide : refusée', async () => {
  const r = await fetch(`${base}/api/billing/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=00' }, body: '{}' });
  assert.equal(r.status, 400);
});
