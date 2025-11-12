const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const cors = require('cors')({ origin: true });
const crypto = require('crypto');
const { Client, PrivateKey, TopicCreateTransaction, TopicMessageSubmitTransaction } = require('@hashgraph/sdk');

const db = admin.firestore();

function makeShortId(prefix='ID'){ return prefix + '_' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,8); }

async function ensureMarketTopic(client){
const cfgRef = db.collection('config').doc('marketTopic');
let topicId = process.env.HCS_MARKET_TOPIC_ID || null;
if (topicId) return topicId;
const doc = await cfgRef.get();
if (doc.exists) return doc.data().topicId;
const create = await new TopicCreateTransaction().execute(client);
const rec = await create.getReceipt(client);
topicId = rec.topicId.toString();
await cfgRef.set({ topicId });
return topicId;
}

async function publishHcs(client, topicId, obj){
const json = JSON.stringify(obj);
const payload = json.length > 1024 ? crypto.createHash('sha256').update(json).digest('hex') : json;
const submit = await new TopicMessageSubmitTransaction({ topicId, message: payload }).execute(client);
const receipt = await submit.getReceipt(client);
return { topicId, transactionId: submit.transactionId.toString(), consensusTimestamp: receipt?.consensusTimestamp?.toString() || null };
}

exports.createAgent = onRequest((req, res) => {
return cors(req, res, async () => {
try{
if (req.method !== 'POST') return res.status(405).send({ error: 'Method Not Allowed' });
const { displayName, role, accountId, contact } = req.body;
if (!displayName || !role || !accountId) return res.status(400).send({ error: 'Missing required fields' });

const agentId = makeShortId('AGT');
const agent = { agentId, accountId, displayName, role, contact: contact || null, createdAt: admin.firestore.FieldValue.serverTimestamp() };
await db.collection('agents').doc(agentId).set(agent);

// Publish HCS anchor
const adminId = process.env.HEDERA_ADMIN_ACCOUNT_ID;
const rawAdmin = process.env.HEDERA_ADMIN_PRIVATE_KEY;
const client = Client.forTestnet().setOperator(adminId, PrivateKey.fromStringECDSA(rawAdmin));
const topicId = await ensureMarketTopic(client);
const hcs = await publishHcs(client, topicId, { type:'AgentCreated', agentId, accountId, role, displayName, timestamp: new Date().toISOString() });

await db.collection('agents').doc(agentId).update({ hcsAnchor: hcs });

return res.status(200).send({ success:true, agentId, hcs });
}catch(err){
console.error('ERROR createAgent', err);
return res.status(500).send({ error: String(err.message || err) });
}
});
});