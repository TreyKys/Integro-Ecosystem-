const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const cors = require('cors')({ origin: true });
const crypto = require('crypto');
const {
Client,
PrivateKey,
TopicCreateTransaction,
TopicMessageSubmitTransaction,
AccountId,
TransferTransaction
} = require('@hashgraph/sdk');

const db = admin.firestore();
const { defineSecret } = require('firebase-functions/params');
// Reuse secrets already defined in index.js; they are available via require('firebase-functions/params') when this module runs as part of functions bundle.

// Config
const DEFAULT_ESCROW_CONTRACT = '0.0.7182623';

function makeShortId(prefix='ID'){
return prefix + '_' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,8);
}

async function ensureMarketTopic(client){
let topicId = process.env.HCS_MARKET_TOPIC_ID;
const cfgRef = db.collection('config').doc('marketTopic');
if (topicId) return topicId;
const doc = await cfgRef.get();
if (doc.exists && doc.data().topicId) return doc.data().topicId;
const createTx = await new TopicCreateTransaction().execute(client);
const createReceipt = await createTx.getReceipt(client);
topicId = createReceipt.topicId.toString();
await cfgRef.set({ topicId });
return topicId;
}

async function publishHcs(client, topicId, jsonObj){
const json = JSON.stringify(jsonObj);
const payload = json.length > 1024 ? crypto.createHash('sha256').update(json).digest('hex') : json;
const submit = await new TopicMessageSubmitTransaction({ topicId, message: payload }).execute(client);
const receipt = await submit.getReceipt(client);
return {
topicId,
transactionId: submit.transactionId.toString(),
consensusTimestamp: receipt?.consensusTimestamp?.toString() || null,
fullPayloadStored: json.length > 1024
};
}

exports.createPendingListing = onRequest((req, res) => {
return cors(req, res, async () => {
try{
if (req.method !== 'POST') return res.status(405).send({ error: 'Method Not Allowed' });
const { sellerAccountId, title, description, priceHbar, assetMetadata } = req.body;
if (!sellerAccountId || !title || !priceHbar) return res.status(400).send({ error: 'Missing required fields' });

const listingId = makeShortId('LST');
const listing = {
listingId,
sellerAccountId,
title,
description: description || '',
priceHbar: Number(priceHbar),
assetMetadata: assetMetadata || null,
state: 'PENDING_VERIFICATION',
tokenId: null,
serialNumber: null,
createdAt: admin.firestore.FieldValue.serverTimestamp(),
};

await db.collection('listings').doc(listingId).set(listing);

// HCS anchor
const adminId = process.env.HEDERA_ADMIN_ACCOUNT_ID; // unused directly here — we will construct client like index.js does
const rawAdminKey = process.env.HEDERA_ADMIN_PRIVATE_KEY; // read env inside Cloud Functions runtime
const client = Client.forTestnet().setOperator(adminId, PrivateKey.fromStringECDSA(rawAdminKey));
const topicId = await ensureMarketTopic(client);
const hcs = await publishHcs(client, topicId, { type: 'ListingCreated', listingId, sellerAccountId, title, priceHbar: Number(priceHbar), timestamp: new Date().toISOString() });

// store HCS payload if big
if (hcs.fullPayloadStored) {
await db.collection('hcsMessages').doc(hcs.transactionId).set({ json: JSON.stringify({ type:'ListingCreated', listing }), createdAt: admin.firestore.FieldValue.serverTimestamp() });
}

// attach anchor metadata to listing doc
await db.collection('listings').doc(listingId).update({ hcsAnchors: admin.firestore.FieldValue.arrayUnion(hcs) });

return res.status(200).send({ success:true, listing, hcs });
}catch(err){
console.error('ERROR createPendingListing', err);
return res.status(500).send({ error: String(err.message || err) });
}
});
});

exports.getListings = onRequest((req, res) => {
return cors(req, res, async () => {
try{
if (req.method !== 'GET') return res.status(405).send({ error: 'Method Not Allowed' });
const q = db.collection('listings').orderBy('createdAt','desc').limit(100);
const snap = await q.get();
const out = [];
snap.forEach(d=> out.push(d.data()));
return res.status(200).send(out);
}catch(err){
console.error('ERROR getListings', err);
return res.status(500).send({ error: String(err.message || err) });
}
});
});

exports.getListing = onRequest((req, res) => {
return cors(req, res, async () => {
try{
if (req.method !== 'GET') return res.status(405).send({ error: 'Method Not Allowed' });
const listingId = req.query.listingId;
if (!listingId) return res.status(400).send({ error: 'Missing listingId' });
const doc = await db.collection('listings').doc(listingId).get();
if (!doc.exists) return res.status(404).send({ error: 'Listing not found' });
return res.status(200).send(doc.data());
}catch(err){
console.error('ERROR getListing', err);
return res.status(500).send({ error: String(err.message || err) });
}
});
});

exports.buyNow = onRequest((req, res) => {
return cors(req, res, async () => {
try{
if (req.method !== 'POST') return res.status(405).send({ error: 'Method Not Allowed' });
const { buyerAccountId, listingId, escrowContractId } = req.body;
if (!buyerAccountId || !listingId) return res.status(400).send({ error: 'Missing buyerAccountId or listingId' });

const listingDoc = await db.collection('listings').doc(listingId).get();
if (!listingDoc.exists) return res.status(404).send({ error: 'Listing not found' });
const listing = listingDoc.data();
if (listing.state === 'SOLD' || listing.state === 'CANCELED') return res.status(400).send({ error: 'Listing not available' });

const purchaseId = makeShortId('PUR');
const purchase = {
purchaseId,
listingId,
buyerAccountId,
sellerAccountId: listing.sellerAccountId,
escrowContractId: escrowContractId || DEFAULT_ESCROW_CONTRACT,
amountHbar: Number(listing.priceHbar),
state: 'AWAITING_PAYMENT',
createdAt: admin.firestore.FieldValue.serverTimestamp()
};

await db.collection('purchases').doc(purchaseId).set(purchase);

// HCS anchor PurchaseCreated
const adminId = process.env.HEDERA_ADMIN_ACCOUNT_ID;
const rawAdminKey = process.env.HEDERA_ADMIN_PRIVATE_KEY;
const client = Client.forTestnet().setOperator(adminId, PrivateKey.fromStringECDSA(rawAdminKey));
const topicId = await ensureMarketTopic(client);
const hcs = await publishHcs(client, topicId, { type:'PurchaseCreated', purchaseId, listingId, buyerAccountId, sellerAccountId: listing.sellerAccountId, amountHbar: Number(listing.priceHbar), escrowContractId: purchase.escrowContractId, timestamp: new Date().toISOString() });

await db.collection('purchases').doc(purchaseId).update({ hcsAnchors: admin.firestore.FieldValue.arrayUnion(hcs) });

// Return instructions for client to call PPSSS / signWithPin to fund the escrow
const signPayload = {
txType: 'fundEscrow',
txParams: { escrowContractId: purchase.escrowContractId, amountHbar: purchase.amountHbar, tokenId: listing.tokenId || null }
};

return res.status(200).send({ success:true, purchase, signPayload, hcs });
}catch(err){
console.error('ERROR buyNow', err);
return res.status(500).send({ error: String(err.message || err) });
}
});
});

// confirmDelivery: called by backend/web after on-chain confirmDelivery receipt success
exports.confirmDelivery = onRequest((req, res) => {
return cors(req, res, async () => {
try{
if (req.method !== 'POST') return res.status(405).send({ error: 'Method Not Allowed' });
const { purchaseId, confirmTxId } = req.body;
if (!purchaseId || !confirmTxId) return res.status(400).send({ error: 'Missing purchaseId or confirmTxId' });

const purchaseDoc = await db.collection('purchases').doc(purchaseId).get();
if (!purchaseDoc.exists) return res.status(404).send({ error: 'Purchase not found' });
const purchase = purchaseDoc.data();
if (purchase.state !== 'AWAITING_PAYMENT' && purchase.state !== 'FUNDED') {
// allow FUNDED or AWAITING_PAYMENT depending on your flow
console.warn('confirmDelivery called with unexpected state', purchase.state);
}

// Execute NFT transfer using admin (allowance) — duplicate minimal logic from index.js
const adminId = process.env.HEDERA_ADMIN_ACCOUNT_ID;
const rawAdminKey = process.env.HEDERA_ADMIN_PRIVATE_KEY;
const adminPrivateKey = PrivateKey.fromStringECDSA(rawAdminKey);
const client = Client.forTestnet().setOperator(adminId, adminPrivateKey);

// We expect listing.tokenId and listing.serialNumber to be set. If not, fail safely.
const listingDoc = await db.collection('listings').doc(purchase.listingId).get();
if (!listingDoc.exists) return res.status(404).send({ error: 'Listing not found' });
const listing = listingDoc.data();
if (!listing.tokenId || listing.serialNumber === null || listing.serialNumber === undefined) {
return res.status(400).send({ error: 'Listing not tokenized yet' });
}

// Transfer NFT from seller -> buyer
const transferTx = await new TransferTransaction()
.addNftTransfer(listing.tokenId, Number(listing.serialNumber), purchase.sellerAccountId, purchase.buyerAccountId)
.freezeWith(client);

const signedTransfer = await transferTx.sign(adminPrivateKey);
const submit = await signedTransfer.execute(client);
const transferReceipt = await submit.getReceipt(client);

if (transferReceipt.status.toString() !== 'SUCCESS') {
throw new Error('NFT transfer failed: ' + transferReceipt.status.toString());
}

// Update purchase doc
await db.collection('purchases').doc(purchaseId).update({ state: 'SOLD', confirmTxId, nftTransferTxId: submit.transactionId.toString(), soldAt: admin.firestore.FieldValue.serverTimestamp() });

// HCS anchor DeliveryConfirmed
const topicId = await ensureMarketTopic(client);
const hcs = await publishHcs(client, topicId, { type:'DeliveryConfirmed', purchaseId, confirmTxId, nftTransferTxId: submit.transactionId.toString(), timestamp: new Date().toISOString() });
await db.collection('purchases').doc(purchaseId).update({ hcsAnchors: admin.firestore.FieldValue.arrayUnion(hcs) });

return res.status(200).send({ success:true, nftTransferTxId: submit.transactionId.toString(), hcs });
}catch(err){
console.error('ERROR confirmDelivery', err);
return res.status(500).send({ error: String(err.message || err) });
}
});
});