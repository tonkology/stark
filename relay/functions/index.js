// Ask STARK relay (Firebase Cloud Function, 2nd gen).
// Holds the Claude API key so it never reaches the students' browsers, checks the team key,
// and limits how many questions each student can ask per day.
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const { handleAsk } = require('./ask');

admin.initializeApp();
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const STARK_TEAM_KEY = defineSecret('STARK_TEAM_KEY');

const PER_USER_PER_DAY = 60;   // messages per student per day (a conversation uses one per message)
const TEAM_PER_DAY = 500;      // messages for the whole team per day
const mem = new Map();         // fallback counter if Firestore is not enabled

async function bump(key, limit) {
  const day = new Date().toISOString().slice(0, 10);
  const id = `${day}_${key}`.replace(/[^\w\-.؀-ۿ]/g, '_').slice(0, 120);
  try {
    const ref = admin.firestore().collection('askStarkUsage').doc(id);
    return await admin.firestore().runTransaction(async tx => {
      const n = ((await tx.get(ref)).data() || {}).n || 0;
      if (n >= limit) return false;
      tx.set(ref, { n: n + 1, day }, { merge: true });
      return true;
    });
  } catch (e) {
    const n = mem.get(id) || 0;
    if (n >= limit) return false;
    mem.set(id, n + 1);
    return true;
  }
}

exports.askStark = onRequest(
  { region: 'europe-west1', cors: true, secrets: [ANTHROPIC_API_KEY, STARK_TEAM_KEY], timeoutSeconds: 90, memory: '512MiB', maxInstances: 3 },
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    const body = req.body || {};
    let user;
    if (body.idToken) {
      // Signed in with Google on the STARK platform: verify the token and check team membership.
      try {
        const tok = await admin.auth().verifyIdToken(String(body.idToken));
        const email = String(tok.email || '').toLowerCase();
        const fs = admin.firestore();
        const owner = await fs.doc('config/owner').get();
        const isOwner = owner.exists && owner.data().uid === tok.uid;
        const mem = isOwner ? null : await fs.doc('members/' + email).get();
        if (!isOwner && !(mem && mem.exists)) return res.status(403).json({ error: 'Your account is not on the team' });
        user = 'uid_' + tok.uid;
      } catch (e) {
        return res.status(401).json({ error: 'Please sign in again' });
      }
    } else {
      if (!body.key || body.key !== STARK_TEAM_KEY.value()) return res.status(401).json({ error: 'Wrong team key' });
      user = String(body.user || 'unknown').slice(0, 60);
    }
    if (!(await bump('team', TEAM_PER_DAY))) return res.status(429).json({ error: 'Daily limit for the team reached' });
    if (!(await bump('u_' + user, PER_USER_PER_DAY))) return res.status(429).json({ error: 'Your daily limit is reached. Try again tomorrow.' });
    try {
      const out = await handleAsk(body, { apiKey: ANTHROPIC_API_KEY.value() });
      if (out.error) return res.status(out.status).json({ error: out.error });
      return res.json({ answer: out.answer });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Relay failed' });
    }
  }
);
