import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.AUTOMATION_TOKEN_KEY = 'phrase-secrete-de-test-suffisamment-longue';
process.env.GOOGLE_CLIENT_ID = 'gid'; process.env.GOOGLE_CLIENT_SECRET = 'gsecret';
const { buildMime, sendMail, encryptToken, decryptToken, refreshAccessToken, MailSendError } = await import('../server/automation/email.ts');

const pdf = Buffer.from('%PDF-1.7 contenu de test');
const mail = { from: 'karim@gmail.com', fromName: 'Karim Dupont', to: 'rh@acme.fr', subject: 'Candidature — Développeur React', text: 'Madame, Monsieur,\nVeuillez trouver ci-joint mon CV.', attachments: [{ filename: 'CV Karim Dupont.pdf', contentType: 'application/pdf', content: pdf }] };

test('MIME : en-têtes encodés, texte et pièce jointe intacts', () => {
  const mime = buildMime(mail, 'B');
  assert.match(mime, /^From: Karim Dupont <karim@gmail\.com>$/m);
  assert.match(mime, /^To: rh@acme\.fr$/m);
  assert.match(mime, /^Subject: =\?UTF-8\?B\?/m);
  const parts = mime.split('--B');
  const body = Buffer.from(parts[1].split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString();
  assert.match(body, /Veuillez trouver ci-joint/);
  const att = Buffer.from(parts[2].split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64');
  assert.ok(att.equals(pdf));
});

test('MIME : injection d’en-têtes et adresse invalide refusées', () => {
  const mime = buildMime({ ...mail, subject: 'x\r\nBcc: pirate@evil.com' }, 'B');
  assert.doesNotMatch(mime, /^Bcc:/m);
  assert.throws(() => buildMime({ ...mail, to: 'pas une adresse' }));
  assert.throws(() => buildMime({ ...mail, to: 'rh@acme.fr\r\nBcc: x@y.fr' }));
});

test('Gmail : message envoyé en base64url, identifiant conservé comme preuve', async () => {
  let sent: any;
  const res = await sendMail('gmail', 'tok', mail, async (url, init) => {
    sent = { url, init };
    return { ok: true, status: 200, json: async () => ({ id: 'msg-123' }), text: async () => '' };
  });
  assert.equal(res.messageId, 'msg-123');
  assert.equal(sent.init.headers.Authorization, 'Bearer tok');
  const raw = Buffer.from(JSON.parse(sent.init.body).raw, 'base64url').toString();
  assert.match(raw, /^To: rh@acme\.fr$/m);
});

test('Outlook : 202 accepté, pièce jointe transmise', async () => {
  let payload: any;
  const res = await sendMail('outlook', 'tok', mail, async (_url, init) => {
    payload = JSON.parse(init.body);
    return { ok: true, status: 202, json: async () => ({}), text: async () => '' };
  });
  assert.equal(res.provider, 'outlook');
  assert.equal(payload.message.toRecipients[0].emailAddress.address, 'rh@acme.fr');
  assert.ok(Buffer.from(payload.message.attachments[0].contentBytes, 'base64').equals(pdf));
});

test('erreurs : 401 = reconnexion, 429/5xx = réessai, 400 = échec définitif', async () => {
  const fail = (status: number) => sendMail('gmail', 'tok', mail, async () => ({ ok: false, status, json: async () => ({}), text: async () => 'err' }));
  await assert.rejects(fail(401), (e: any) => e instanceof MailSendError && e.authExpired && !e.retryable);
  await assert.rejects(fail(429), (e: any) => e.retryable);
  await assert.rejects(fail(503), (e: any) => e.retryable);
  await assert.rejects(fail(400), (e: any) => !e.retryable && !e.authExpired);
});

test('jetons chiffrés (AES-256-GCM) : illisibles, et toute altération est détectée', () => {
  const sealed = encryptToken('ya29.secret');
  assert.doesNotMatch(sealed, /secret/);
  assert.equal(decryptToken(sealed), 'ya29.secret');
  const parts = sealed.split('.');
  parts[3] = Buffer.from('autre-chose').toString('base64');
  assert.throws(() => decryptToken(parts.join('.')));
});

test('renouvellement OAuth : nouveau jeton, autorisation révoquée signalée', async () => {
  const ok = await refreshAccessToken('gmail', 'r1', async (_u, init) => {
    assert.match(init.body, /grant_type=refresh_token/);
    return { ok: true, status: 200, json: async () => ({ access_token: 'a2', expires_in: 3599 }), text: async () => '' };
  });
  assert.equal(ok.accessToken, 'a2');
  await assert.rejects(refreshAccessToken('gmail', 'r1', async () => ({ ok: false, status: 400, json: async () => ({}), text: async () => '{"error":"invalid_grant"}' })), (e: any) => e.authExpired);
});
