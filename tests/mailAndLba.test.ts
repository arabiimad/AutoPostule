import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LbaChannel, RetryableError, normalizePhone, splitName, type ChannelContext } from '../server/automation/channels.ts';
import { GoogleMail, buildMime, signState, verifyState } from '../server/automation/gmail.ts';
import { MemoryAutomationStore } from '../server/automation/store.ts';
import { AesGcmCipher } from '../server/automation/vault.ts';

const cipher = new AesGcmCipher([Buffer.alloc(32, 9).toString('base64')]);
const candidate = { fullName: 'Camille Martin-Durand', email: 'camille@example.com', phone: '+33 6 12 34 56 78' };
const ctx = (over: Partial<ChannelContext> = {}): ChannelContext => ({
  uid: 'u1',
  task: {} as any,
  job: { title: 'Alternance développeur', company: 'Acme', lbaRecipientId: 'rcpt-42' },
  candidate,
  documents: { coverLetter: 'Madame, Monsieur…', latexCode: '', cvPdfBase64: 'JVBERi0xLjQ=', notices: [], preparedAt: '' },
  resolution: {},
  vault: {} as any,
  skipped: [],
  answer: async () => ({ resolved: [], unresolved: [] }),
  ...over
});
const json = (status: number, body: any) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

// ---------------------------------------------------------------------------
// La bonne alternance
// ---------------------------------------------------------------------------
test('La bonne alternance : requête conforme à la documentation (POST /job/v1/apply)', async () => {
  let call: any;
  const ch = new LbaChannel({ apiKey: 'cle', baseUrl: 'https://lba.test/api', fetch: async (url, init) => { call = { url, ...init, body: JSON.parse(init.body) }; return json(202, { id: 'app-1' }); } });
  assert.equal(ch.canHandle({ lbaRecipientId: 'x' }), true);
  assert.equal(ch.canHandle({}), false);
  const out = await ch.apply(ctx());
  assert.deepEqual(out, { kind: 'submitted', reference: 'app-1', details: { via: 'La bonne alternance', recipientId: 'rcpt-42' } });
  assert.equal(call.url, 'https://lba.test/api/job/v1/apply');
  assert.equal(call.headers.Authorization, 'Bearer cle');
  assert.deepEqual(call.body, {
    applicant_first_name: 'Camille',
    applicant_last_name: 'Martin-Durand',
    applicant_email: 'camille@example.com',
    applicant_phone: '0612345678',
    applicant_attachment_name: 'CV_Camille_Martin_Durand.pdf',
    applicant_attachment_content: 'JVBERi0xLjQ=',
    applicant_message: 'Madame, Monsieur…',
    recipient_id: 'rcpt-42'
  });
});

test('La bonne alternance : limite de débit → nouvelle tentative ; droits manquants ou profil incomplet → canal suivant', async () => {
  const limited = new LbaChannel({ apiKey: 'k', fetch: async () => json(429, {}) });
  await assert.rejects(limited.apply(ctx()), RetryableError);
  const forbidden = new LbaChannel({ apiKey: 'k', fetch: async () => json(403, {}) });
  assert.equal((await forbidden.apply(ctx())).kind, 'unavailable');
  const ok = new LbaChannel({ apiKey: 'k', fetch: async () => json(202, { id: 'x' }) });
  assert.match((await ok.apply(ctx({ candidate: { fullName: 'Camille', email: 'c@x.fr' } })) as any).reason, /nom, téléphone/);
  const noPdf = await ok.apply(ctx({ documents: { coverLetter: '', latexCode: '', notices: [], preparedAt: '' } }));
  assert.equal(noPdf.kind, 'unavailable');
  assert.deepEqual(splitName('  Jean  '), { first: 'Jean', last: '' });
  assert.equal(normalizePhone('06.12.34.56.78'), '0612345678');
});

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------
test('Gmail : message MIME avec accents, pièce jointe, sans injection d\'en-tête', () => {
  const mime = buildMime('camille@gmail.com', {
    to: 'rh@acme.fr\r\nBcc: pirate@x.fr',
    subject: 'Candidature — Développeur',
    text: 'Bonjour, voici ma candidature. Émile',
    replyTo: 'camille@example.com',
    attachments: [{ filename: 'CV_Camille.pdf', contentBase64: Buffer.from('%PDF-1.4 test').toString('base64'), contentType: 'application/pdf' }]
  }, 'BOUNDARY');
  assert.ok(!/^Bcc:/m.test(mime), 'pas d\'en-tête injecté');
  assert.match(mime, /^To: rh@acme\.fr Bcc: pirate@x\.fr$/m);
  assert.match(mime, /^Subject: =\?UTF-8\?B\?/m);
  assert.match(mime, /Content-Disposition: attachment; filename="CV_Camille.pdf"/);
  const body = mime.split('--BOUNDARY')[1].split('\r\n\r\n')[1];
  assert.equal(Buffer.from(body, 'base64').toString('utf8'), 'Bonjour, voici ma candidature. Émile');
  assert.ok(mime.trimEnd().endsWith('--BOUNDARY--'));
});

test('Gmail : state signé (falsification et expiration refusées)', () => {
  const s = signState('u1', 'secret');
  assert.equal(verifyState(s, 'secret'), 'u1');
  assert.equal(verifyState(s, 'autre-secret'), null);
  assert.equal(verifyState(s.replace(/^./, 'x'), 'secret'), null);
  assert.equal(verifyState(signState('u1', 'secret', 1000, Date.now() - 5000), 'secret'), null);
});

function fakeGoogle() {
  const calls: { url: string; body: any; headers: any }[] = [];
  const idToken = `x.${Buffer.from(JSON.stringify({ email: 'camille@gmail.com' })).toString('base64url')}.y`;
  let refreshError = false;
  const fetch = async (url: string, init: any = {}) => {
    calls.push({ url, body: init.body, headers: init.headers });
    if (url === 'https://token.test') {
      const p = new URLSearchParams(init.body);
      if (p.get('grant_type') === 'authorization_code') {
        return json(200, { access_token: 'at-1', expires_in: 3600, refresh_token: 'rt-secret', scope: 'https://www.googleapis.com/auth/gmail.send openid email', id_token: idToken });
      }
      return refreshError ? json(400, { error: 'invalid_grant' }) : json(200, { access_token: 'at-2', expires_in: 3600 });
    }
    if (url === 'https://gmail.test/send') return json(200, { id: 'msg-1' });
    return json(200, {});
  };
  return { calls, fetch, failRefresh: () => { refreshError = true; } };
}

test('Gmail : connexion, jeton chiffré, envoi, puis accès retiré → boîte désactivée', async () => {
  const store = new MemoryAutomationStore();
  const g = fakeGoogle();
  const mail = new GoogleMail({ clientId: 'cid', clientSecret: 'cs', redirectUri: 'https://app/cb', stateSecret: 'st', tokenUrl: 'https://token.test', gmailUrl: 'https://gmail.test/send', revokeUrl: 'https://revoke.test', fetch: g.fetch }, store, cipher);

  const url = new URL(mail.authorizationUrl('u1'));
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.send openid email');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  const state = url.searchParams.get('state')!;

  await assert.rejects(mail.handleCallback('code', 'faux'), /expiré ou invalide/);
  assert.deepEqual(await mail.handleCallback('code', state), { uid: 'u1', email: 'camille@gmail.com' });
  const conn = await store.getMailConnection('u1', 'google');
  assert.equal(conn?.email, 'camille@gmail.com');
  assert.ok(!conn!.secret.includes('rt-secret'), 'jeton chiffré');

  const sender = await mail.senderFor('u1');
  assert.equal(sender?.from, 'camille@gmail.com');
  const res = await sender!.send({ to: 'rh@acme.fr', subject: 'Candidature', text: 'Bonjour', attachments: [] });
  assert.equal(res.messageId, 'msg-1');
  const sent = g.calls.find((c) => c.url === 'https://gmail.test/send')!;
  assert.equal(sent.headers.Authorization, 'Bearer at-1');
  assert.match(Buffer.from(JSON.parse(sent.body).raw, 'base64url').toString(), /^From: camille@gmail\.com\r\nTo: rh@acme\.fr/);

  // Jeton d'accès expiré puis accès retiré par l'utilisateur
  (mail as any).accessTokens.clear();
  g.failRefresh();
  await assert.rejects(sender!.send({ to: 'rh@acme.fr', subject: 'x', text: 'x', attachments: [] }), /Accès Gmail retiré/);
  assert.equal((await store.getMailConnection('u1', 'google'))?.status, 'revoked');
  assert.equal(await mail.senderFor('u1'), null);

  await mail.disconnect('u1');
  assert.equal(await store.getMailConnection('u1', 'google'), null);
  assert.ok(g.calls.some((c) => c.url.startsWith('https://revoke.test?token=rt-secret')));
});

test('Gmail : autorisation d\'envoi refusée sur l\'écran Google → message clair', async () => {
  const store = new MemoryAutomationStore();
  const mail = new GoogleMail({
    clientId: 'c', clientSecret: 's', redirectUri: 'r', stateSecret: 'st', tokenUrl: 'https://token.test',
    fetch: async () => json(200, { access_token: 'a', refresh_token: 'r', scope: 'openid email', id_token: 'x.e30.y' })
  }, store, cipher);
  await assert.rejects(mail.handleCallback('code', signState('u1', 'st')), /Envoyer des e-mails/);
});
