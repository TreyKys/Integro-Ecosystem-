// functions/index.js
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require('firebase-functions/params');
const admin = require("firebase-admin");
const cors = require("cors")({ origin: true });
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const fetch = require("node-fetch"); // if needed for internal HTTP fetches (optional)
const {
  Client,
  PrivateKey,
  AccountCreateTransaction,
  Hbar,
  PublicKey,
  AccountId,
  TokenMintTransaction,
  TransferTransaction,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  AccountAllowanceApproveTransaction,
} = require("@hashgraph/sdk");
const ethers = require("ethers");

// Initialize Firebase Admin SDK
admin.initializeApp();
const db = admin.firestore();

// Define secrets
const hederaAdminAccountId = defineSecret('HEDERA_ADMIN_ACCOUNT_ID');
const hederaAdminPrivateKey = defineSecret('HEDERA_ADMIN_PRIVATE_KEY');
const hederaAdminSupplyKey = defineSecret('HEDERA_ADMIN_SUPPLY_KEY');
const pinSignerPrivateKey = defineSecret('PIN_SIGNER_PRIVATE_KEY');
const pinSignerAccountId = defineSecret('PIN_SIGNER_ACCOUNT_ID');
const adminAuthToken = defineSecret('ADMIN_AUTH_TOKEN');

// --- Configuration ---
const assetTokenContractId = "0.0.7134449"; // IVA token (RWA) default
const DEFAULT_USSD_HCS_DOC = 'ussdTopic';
const DEFAULT_DID_HCS_DOC = 'didTopic';

// Utility functions
function isValidEvmAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}
function toEvmAddress(accountIdString) {
  if (isValidEvmAddress(accountIdString)) return accountIdString;
  try { return `0x${AccountId.fromString(accountIdString).toSolidityAddress()}`; }
  catch (e) { return null; }
}

// ---------- Helper: Hedera client with admin operator ----------
async function getAdminClient() {
  const adminId = hederaAdminAccountId.value();
  const rawAdminPrivateKey = hederaAdminPrivateKey.value();
  if (!adminId || !rawAdminPrivateKey) throw new Error("Admin credentials are not set as secrets.");
  const adminPriv = PrivateKey.fromStringECDSA(rawAdminPrivateKey);
  const client = Client.forTestnet().setOperator(adminId, adminPriv);
  return client;
}

// ---------- Helper: Get or create HCS topic by config doc name ----------
async function getOrCreateHcsTopic(client, configDocName) {
  // configDocName: string doc id under collection 'config', e.g., 'didTopic' or 'ussdTopic'
  const cfgRef = db.collection('config').doc(configDocName);
  const cfgDoc = await cfgRef.get();
  if (cfgDoc.exists && cfgDoc.data().topicId) return cfgDoc.data().topicId;
  // create topic
  const createTopicTx = await new TopicCreateTransaction().execute(client);
  const createTopicReceipt = await createTopicTx.getReceipt(client);
  const topicId = createTopicReceipt.topicId.toString();
  await cfgRef.set({ topicId }, { merge: true });
  return topicId;
}

// ---------- Helper: submit an object to HCS (JSON or hash if >1024) ----------
async function anchorToHcs(client, configDocName, jsonObject) {
  try {
    const topicId = process.env[`HCS_${configDocName.toUpperCase()}_ID`] || await getOrCreateHcsTopic(client, configDocName);
    const jsonStr = JSON.stringify(jsonObject);
    const payload = jsonStr.length > 1024 ? crypto.createHash("sha256").update(jsonStr).digest("hex") : jsonStr;
    const submitTx = await new TopicMessageSubmitTransaction({ topicId, message: payload }).execute(client);
    const receipt = await submitTx.getReceipt(client);
    const consensusTimestamp = receipt?.consensusTimestamp?.toString() || null;
    return { topicId, transactionId: submitTx.transactionId.toString(), consensusTimestamp };
  } catch (err) {
    // Do not fail entire flow on HCS error — surface it upstream
    console.error("anchorToHcs error:", err);
    throw err;
  }
}

// ---------- Helper: Perform admin-assisted NFT transfer (reused) ----------
async function performNativeNftTransfer({ sellerAccountId, buyerAccountId, serialNumber, sellerPrivateKey }) {
  // Use admin credentials for submission, but attempt allowance with sellerKey if provided
  const adminId = hederaAdminAccountId.value();
  const rawAdminPrivateKey = hederaAdminPrivateKey.value();
  if (!rawAdminPrivateKey || !adminId) throw new Error("Admin credentials are not set as secrets.");
  const adminPrivateKey = PrivateKey.fromStringECDSA(rawAdminPrivateKey);
  const client = Client.forTestnet().setOperator(adminId, adminPrivateKey);
  const assetTokenId = assetTokenContractId;

  // If seller's private key provided, try create allowance first
  if (sellerPrivateKey) {
    try {
      let sellerKeyInput = sellerPrivateKey;
      if (typeof sellerKeyInput !== 'string') throw new Error("sellerPrivateKey must be a string.");
      if (sellerKeyInput.startsWith('0x')) sellerKeyInput = sellerKeyInput.slice(2);
      let sellerPrivateKeyObj;
      try { sellerPrivateKeyObj = PrivateKey.fromStringECDSA(sellerKeyInput); }
      catch (err) {
        try { sellerPrivateKeyObj = PrivateKey.fromString(sellerPrivateKey); }
        catch (err2) { throw new Error("Failed to parse sellerPrivateKey"); }
      }

      const sellerClient = Client.forTestnet().setOperator(sellerAccountId, sellerPrivateKeyObj);
      const approveTx = await new AccountAllowanceApproveTransaction()
        .approveTokenNftAllowance(assetTokenId, sellerAccountId, adminId, [Number(serialNumber)])
        .freezeWith(sellerClient);
      const signedApprove = await approveTx.sign(sellerPrivateKeyObj);
      const approveSubmit = await signedApprove.execute(sellerClient);
      const approveReceipt = await approveSubmit.getReceipt(sellerClient);
      console.log("Allowance receipt status:", approveReceipt.status.toString());
    } catch (allowErr) {
      const msg = String(allowErr && allowErr.message ? allowErr.message : allowErr);
      console.warn("Allowance step failed:", msg);
      const tolerantPatterns = ["ALREADY", "already approved", "TOKEN_ALREADY_APPROVED", "ALREADY_EXISTS", "ACCOUNT_ALREADY_APPROVED"];
      const tolerable = tolerantPatterns.some(p => msg.toLowerCase().includes(p.toLowerCase()));
      if (!tolerable) throw new Error(`Failed to create allowance: ${msg}`);
      console.log("Allowance likely already present — continuing.");
    }
  } else {
    console.log("No sellerPrivateKey provided; attempting admin transfer (allowance must already exist).");
  }

  // Build & submit transfer (admin signs)
  const transferTxFrozen = await new TransferTransaction()
    .addNftTransfer(assetTokenId, Number(serialNumber), sellerAccountId, buyerAccountId)
    .freezeWith(client);
  const signedTransferTx = await transferTxFrozen.sign(adminPrivateKey);
  const transferTxSubmit = await signedTransferTx.execute(client);
  const transferReceipt = await transferTxSubmit.getReceipt(client);
  if (transferReceipt.status.toString() !== 'SUCCESS') throw new Error(`NFT transfer failed with status: ${transferReceipt.status.toString()}`);
  return { transactionId: transferTxSubmit.transactionId.toString(), status: transferReceipt.status.toString() };
}


// ---------------------- Existing functions (kept intact) ----------------------
// createAccount, executeNativeNftTransfer, mintRWAviaUSSD, setUserProfile, setPin, signWithPin, revokePin, getSignLog
// We'll paste your existing (working) implementations here — unchanged except small refactor to call performNativeNftTransfer.
// (I include them below; ensure they match your working version.)

// ---------------------- Account Factory / DID Anchoring ----------------------
exports.createAccount = onRequest({ secrets: [hederaAdminAccountId, hederaAdminPrivateKey] }, (request, response) => {
  cors(request, response, async () => {
    if (request.method !== "POST") return response.status(405).send("Method Not Allowed");
    try {
      const adminAccountId = hederaAdminAccountId.value();
      const rawAdminPrivateKey = hederaAdminPrivateKey.value();
      if (!adminAccountId || !rawAdminPrivateKey) throw new Error("Admin credentials are not set as secrets.");
      const adminPrivateKey = PrivateKey.fromStringECDSA(rawAdminPrivateKey);
      const client = Client.forTestnet().setOperator(adminAccountId, adminPrivateKey);
      const newPriv = PrivateKey.generateECDSA();
      const newPrivHex0x = "0x" + newPriv.toStringRaw();
      const newPubKey = newPriv.publicKey;
      const acctTx = new AccountCreateTransaction().setKey(newPubKey).setInitialBalance(new Hbar(65));
      const acctSubmit = await acctTx.execute(client);
      const acctReceipt = await acctSubmit.getReceipt(client);
      const newAccountId = acctReceipt.accountId;
      if (!newAccountId) throw new Error("Failed to create account; no account id returned.");
      const evmAddress = (new ethers.Wallet(newPrivHex0x)).address;

      // DID doc
      const didDoc = {
        id: "",
        controller: newAccountId.toString(),
        evmAddress,
        publicKeyHex: newPubKey.toStringRaw(),
        created: new Date().toISOString()
      };
      const initialDidDocJson = JSON.stringify(didDoc);
      const initialDidHash = crypto.createHash("sha256").update(initialDidDocJson).digest("hex");
      const did = `did:integro:${initialDidHash.substring(0, 16)}`;
      didDoc.id = did;
      const finalDidDocJson = JSON.stringify(didDoc);
      const finalDidHash = crypto.createHash("sha256").update(finalDidDocJson).digest("hex");

      // HCS anchor (use 'didTopic' config)
      const topicId = process.env.HCS_DID_TOPIC_ID || await getOrCreateHcsTopic(client, DEFAULT_DID_HCS_DOC);
      const message = finalDidDocJson.length > 1024 ? finalDidHash : finalDidDocJson;
      const submitMessageTx = await new TopicMessageSubmitTransaction({ topicId, message }).execute(client);
      const submitMessageReceipt = await submitMessageTx.getReceipt(client);
      const consensusTimestamp = submitMessageReceipt?.consensusTimestamp?.toString() || null;
      const didAnchor = { topicId, transactionId: submitMessageTx.transactionId.toString(), consensusTimestamp };

      // Save DID document
      await db.collection('dids').doc(did).set({
        doc: didDoc,
        accountId: newAccountId.toString(),
        evmAddress,
        anchored: didAnchor,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return response.status(200).send({ accountId: newAccountId.toString(), privateKey: newPrivHex0x, evmAddress, did, didAnchor });
    } catch (error) {
      console.error("FATAL ERROR in createAccount function:", error);
      return response.status(500).send({ error: error.message });
    }
  });
});

// ---------------------- NEW: Agent-based Listing Verification Flow ----------------------

exports.claimListing = onRequest({ secrets: [hederaAdminAccountId, hederaAdminPrivateKey] }, (request, response) => {
  cors(request, response, async () => {
    if (request.method !== "POST") return response.status(405).send({ error: "Method Not Allowed" });
    try {
      const { listingId, agentId, agentAccountId } = request.body;
      if (!listingId || !agentId || !agentAccountId) return response.status(400).send({ error: "Missing required fields." });

      // Auth: validate agent
      const agentRef = db.collection("agents").doc(agentId);
      const agentSnap = await agentRef.get();
      if (!agentSnap.exists || agentSnap.data().accountId !== agentAccountId) return response.status(403).send({ error: "Unauthorized: Invalid agent." });

      // Validate listing
      const listingRef = db.collection("listings").doc(listingId);
      const listingSnap = await listingRef.get();
      if (!listingSnap.exists) return response.status(404).send({ error: "Listing not found." });
      if (listingSnap.data().state !== "PENDING_VERIFICATION") return response.status(400).send({ error: "Listing is not pending verification." });

      // Update listing
      const updates = {
        assignedAgent: agentId,
        state: "UNDER_VERIFICATION",
        assignedAt: admin.firestore.FieldValue.serverTimestamp()
      };
      await listingRef.update(updates);

      // HCS anchor
      const client = await getAdminClient();
      const hcsMsg = { type: "ListingClaimed", listingId, agentId, agentAccountId, timestamp: new Date().toISOString() };
      const anchor = await anchorToHcs(client, DEFAULT_USSD_HCS_DOC, hcsMsg);
      await listingRef.update({ hcsAnchors: admin.firestore.FieldValue.arrayUnion(anchor) });

      return response.status(200).send({ success: true, listingId, hcsAnchor: anchor });

    } catch (error) {
      console.error("ERROR in claimListing:", error);
      return response.status(500).send({ error: String(error?.message || error) });
    }
  });
});

exports.verifyListing = onRequest({ secrets: [hederaAdminAccountId, hederaAdminPrivateKey, hederaAdminSupplyKey] }, (request, response) => {
  cors(request, response, async () => {
    if (request.method !== "POST") return response.status(405).send({ error: "Method Not Allowed" });
    try {
      const { listingId, agentId, agentAccountId, evidence, extraMetadata } = request.body;
      if (!listingId || !agentId || !agentAccountId) return response.status(400).send({ error: "Missing required fields." });

      // Auth: validate agent
      const agentRef = db.collection("agents").doc(agentId);
      const agentSnap = await agentRef.get();
      if (!agentSnap.exists || agentSnap.data().accountId !== agentAccountId) return response.status(403).send({ error: "Unauthorized: Invalid agent." });

      // Validate listing
      const listingRef = db.collection("listings").doc(listingId);
      const listingSnap = await listingRef.get();
      if (!listingSnap.exists) return response.status(404).send({ error: "Listing not found." });
      const listing = listingSnap.data();
      if (listing.state !== "UNDER_VERIFICATION" || listing.assignedAgent !== agentId) return response.status(400).send({ error: "Listing not assigned to this agent for verification." });

      // Prepare metadata
      const evidenceHash = evidence && evidence.length > 0 ? crypto.createHash("sha256").update(JSON.stringify(evidence)).digest("hex") : null;
      const combinedMetadata = { ...listing.assetMetadata, agentId, verifiedAt: new Date().toISOString(), evidenceHash, ...extraMetadata };
      const metadataBuffer = Buffer.from(JSON.stringify(combinedMetadata));

      // Metadata size guard
      if (metadataBuffer.length > 100) {
        // Store full evidence in Firestore, anchor only hash to HCS
        await listingRef.update({ evidence }); // Store full evidence object
        const hcsHashPayload = { type: "LargeMetadata", listingId, metadataHash: crypto.createHash("sha256").update(metadataBuffer).digest("hex") };
        const client = await getAdminClient();
        await anchorToHcs(client, DEFAULT_USSD_HCS_DOC, hcsHashPayload);
        // For NFT, we must still use a sub-100-byte buffer. We can use a truncated or hashed version.
        // Let's use a hash for consistency.
        const nftMetadata = { listingId, metadataHash: hcsHashPayload.metadataHash };
        const nftMetadataBuffer = Buffer.from(JSON.stringify(nftMetadata));
        // Mint NFT with hashed metadata
        await mintAndTransfer(listing.sellerAccountId, nftMetadataBuffer);
      } else {
        // Mint NFT with full metadata
        await mintAndTransfer(listing.sellerAccountId, metadataBuffer);
      }

      const { serialNumber } = await mintAndTransfer(listing.sellerAccountId, metadataBuffer);

      // Update listing state
      const updates = {
        tokenId: assetTokenContractId,
        serialNumber,
        state: "VERIFIED",
        verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
        verifiedBy: agentId,
      };
      await listingRef.update(updates);

      // HCS anchor
      const client = await getAdminClient();
      const hcsMsg = { type: "ListingVerified", listingId, tokenId: assetTokenContractId, serialNumber, agentId, timestamp: new Date().toISOString() };
      const anchor = await anchorToHcs(client, DEFAULT_USSD_HCS_DOC, hcsMsg);
      await listingRef.update({ hcsAnchors: admin.firestore.FieldValue.arrayUnion(anchor) });

      return response.status(200).send({ success: true, tokenId: assetTokenContractId, serialNumber, listingId, hcsAnchor: anchor });

    } catch (error) {
      console.error("ERROR in verifyListing:", error);
      return response.status(500).send({ error: String(error?.message || error) });
    }
  });
});

async function mintAndTransfer(sellerAccountId, metadataBuffer) {
  const adminId = hederaAdminAccountId.value();
  const rawAdminPrivateKey = hederaAdminPrivateKey.value();
  const rawSupplyKey = hederaAdminSupplyKey.value();
  if (!rawAdminPrivateKey || !adminId || !rawSupplyKey) throw new Error("Admin credentials or supply key are not set as secrets.");
  const adminPrivateKey = PrivateKey.fromStringECDSA(rawAdminPrivateKey);
  const supplyPrivateKey = PrivateKey.fromStringED25519(rawSupplyKey);
  const client = Client.forTestnet().setOperator(adminId, adminPrivateKey);

  const mintTx = await new TokenMintTransaction().setTokenId(assetTokenContractId).setMetadata([metadataBuffer]).freezeWith(client);
  const signedMintTx = await mintTx.sign(supplyPrivateKey);
  const mintTxSubmit = await signedMintTx.execute(client);
  const mintRx = await mintTxSubmit.getReceipt(client);
  if (!mintRx.serials || mintRx.serials.length === 0) throw new Error("Minting succeeded but no serial number was returned.");
  const serialNumber = Number(mintRx.serials[0].toString());

  const transferTx = await new TransferTransaction().addNftTransfer(assetTokenContractId, serialNumber, adminId, sellerAccountId).freezeWith(client).execute(client);
  await transferTx.getReceipt(client);

  return { serialNumber };
}


// ---------------------- Scheduled Fallback (Stub) ----------------------

// TODO: Deploy as a separate scheduled function if needed.
// This is a stub for a potential cron job to handle fallback scenarios.
exports.autoConfirmFallback = onRequest((request, response) => {
  // This would be triggered by Cloud Scheduler, not a direct web call.
  // It would query for purchases where delivery was confirmed by agent but not buyer for >24h.
  console.log("autoConfirmFallback STUB called. No action taken.");
  // Example logic:
  // const now = admin.firestore.Timestamp.now();
  // const yesterday = new admin.firestore.Timestamp(now.seconds - 86400, now.nanoseconds);
  // const query = db.collection('purchases')
  //   .where('state', '==', 'DELIVERED_BY_AGENT')
  //   .where('agentDeliveryConfirmedAt', '<', yesterday);
  // const snapshot = await query.get();
  // for (const doc of snapshot.docs) {
  //    const purchase = doc.data();
  //    // Call confirmDelivery logic here for purchase.purchaseId
  // }
  response.status(200).send({ success: true, message: "Fallback stub executed." });
});

// ---------------------- Native NFT transfer endpoint (wrap performNativeNftTransfer) ----------------------
exports.executeNativeNftTransfer = onRequest({ secrets: [hederaAdminAccountId, hederaAdminPrivateKey] }, (request, response) => {
  cors(request, response, async () => {
    if (request.method !== "POST") return response.status(405).send("Method Not Allowed");
    try {
      const { sellerAccountId, buyerAccountId, serialNumber, sellerPrivateKey } = request.body;
      if (!sellerAccountId || !buyerAccountId || (serialNumber === undefined || serialNumber === null)) {
        return response.status(400).send({ error: "Missing required fields: sellerAccountId, buyerAccountId, serialNumber." });
      }
      const result = await performNativeNftTransfer({ sellerAccountId, buyerAccountId, serialNumber, sellerPrivateKey });
      return response.status(200).send({ success: true, ...result });
    } catch (error) {
      console.error("ERROR in executeNativeNftTransfer:", error);
      return response.status(500).send({ error: String(error.message || error) });
    }
  });
});

// ---------------------- Mint RWA via USSD (unchanged) ----------------------
exports.mintRWAviaUSSD = onRequest({
  secrets: [hederaAdminAccountId, hederaAdminPrivateKey, hederaAdminSupplyKey]
}, (request, response) => {
  cors(request, response, async () => {
    if (request.method !== "POST") return response.status(405).send("Method Not Allowed");
    try {
      const { accountId, assetType, quality, location } = request.body;
      if (!accountId || !assetType || !quality || !location) throw new Error("Missing required fields: accountId, assetType, quality, location.");
      const adminId = hederaAdminAccountId.value();
      const rawAdminPrivateKey = hederaAdminPrivateKey.value();
      const rawSupplyKey = hederaAdminSupplyKey.value();
      if (!rawAdminPrivateKey || !adminId || !rawSupplyKey) throw new Error("Admin credentials or supply key are not set as secrets.");
      const adminPrivateKey = PrivateKey.fromStringECDSA(rawAdminPrivateKey);
      const supplyPrivateKey = PrivateKey.fromStringED25519(rawSupplyKey);
      const client = Client.forTestnet().setOperator(adminId, adminPrivateKey);
      const metadata = Buffer.from(JSON.stringify({ assetType, quality, location }));
      if (metadata.length > 100) throw new Error("Metadata exceeds 100 bytes limit.");
      const mintTx = await new TokenMintTransaction().setTokenId(assetTokenContractId).setMetadata([metadata]).freezeWith(client);
      const signedMintTx = await mintTx.sign(supplyPrivateKey);
      const mintTxSubmit = await signedMintTx.execute(client);
      const mintRx = await mintTxSubmit.getReceipt(client);
      if (!mintRx.serials || mintRx.serials.length === 0) throw new Error("Minting succeeded but no serial number was returned.");
      const serialNumber = Number(mintRx.serials[0].toString());
      const transferTx = await new TransferTransaction().addNftTransfer(assetTokenContractId, serialNumber, adminId, accountId).freezeWith(client).execute(client);
      const transferRx = await transferTx.getReceipt(client);
      if (transferRx.status.toString() !== 'SUCCESS') throw new Error(`NFT transfer failed with status: ${transferRx.status.toString()}`);
      console.log(`SUCCESS: RWA minted and transferred to user ${accountId}. New Serial Number: ${serialNumber}.`);
      return response.status(200).send({ tokenId: assetTokenContractId, serialNumber });
    } catch (error) {
      console.error("ERROR minting RWA via USSD:", error);
      if (error.message && error.message.includes("ACCOUNT_KYC_NOT_GRANTED_FOR_TOKEN")) return response.status(400).send({ error: "User account must be KYC'd and associated with the token before minting." });
      if (error.message && error.message.includes("INVALID_SIGNATURE")) return response.status(400).send({ error: "Invalid signature. Check that supply key matches the token's supply key and all keys are correct." });
      if (error.message && error.message.includes("INVALID_TOKEN_ID")) return response.status(400).send({ error: "Invalid token ID. Check assetTokenContractId." });
      if (error.message && error.message.includes("INSUFFICIENT_TX_FEE")) return response.status(400).send({ error: "Insufficient transaction fee. Try increasing the gas limit or check your account balance." });
      return response.status(500).send({ error: error.message });
    }
  });
});

// ---------------------- setUserProfile (simple) ----------------------
exports.setUserProfile = onRequest((request, response) => {
  cors(request, response, async () => {
    if (request.method !== "POST") return response.status(405).send("Method Not Allowed");
    try {
      const { accountId, displayName, role, location } = request.body;
      if (!accountId || !displayName || !role || !location) return response.status(400).send({ error: "Missing required profile fields." });
      const profileRef = db.collection("profiles").doc(accountId);
      await profileRef.set({ displayName, role, location, createdAt: admin.firestore.FieldValue.serverTimestamp() });
      console.log(`SUCCESS: Profile created/updated for account ${accountId}`);
      return response.status(200).send({ success: true, message: "Profile saved." });
    } catch (error) {
      console.error("ERROR in setUserProfile function:", error);
      return response.status(500).send({ error: error.message });
    }
  });
});

// ---------------------- PIN Management ----------------------
exports.setPin = onRequest({ secrets: [] }, (request, response) => {
  cors(request, response, async () => {
    if (request.method !== "POST") return response.status(405).send("Method Not Allowed");
    try {
      const { accountId, pin } = request.body;
      if (!accountId || !pin) return response.status(400).send({ error: "Missing accountId or pin." });
      if (typeof pin !== 'string' || pin.length < 4 || pin.length > 6 || !/^\d+$/.test(pin)) return response.status(400).send({ error: "PIN must be a string of 4-6 digits." });
      const saltRounds = 12;
      const hashedPin = await bcrypt.hash(pin, saltRounds);
      const pinRef = db.collection("pins").doc(accountId);
      await pinRef.set({ hashedPin, createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      console.log(`SUCCESS: PIN has been set/updated for account ${accountId}.`);
      return response.status(200).send({ success: true });
    } catch (error) {
      console.error("ERROR in setPin function:", error);
      return response.status(500).send({ error: "An internal error occurred." });
    }
  });
});

// ---------------------- Sign with PIN (PPSSS) ----------------------
exports.signWithPin = onRequest({
  secrets: [pinSignerPrivateKey, pinSignerAccountId, hederaAdminAccountId]
}, (request, response) => {
  cors(request, response, async () => {
    if (request.method !== "POST") return response.status(405).send({ error: "Method Not Allowed" });
    try {
      const { accountId, pin, txType, txParams } = request.body;
      if (!accountId || !pin || !txType || !txParams) return response.status(400).send({ error: "Missing required fields: accountId, pin, txType, txParams." });

      // Rate limiting + verify PIN (same as before)
      const attemptsDocRef = db.collection('pinAttempts').doc(accountId);
      const attemptsDoc = await attemptsDocRef.get();
      const now = Date.now();
      const windowStart = now - (15 * 60 * 1000);
      if (attemptsDoc.exists) {
        const data = attemptsDoc.data();
        const recentAttempts = Array.isArray(data.attempts) ? data.attempts.filter(ts => ts > windowStart) : [];
        if (recentAttempts.length >= 5) return response.status(429).send({ error: "Too many attempts. Please try again later." });
        await attemptsDocRef.update({ attempts: [...recentAttempts, now] });
      } else { await attemptsDocRef.set({ attempts: [now] }); }

      const pinRef = db.collection("pins").doc(accountId);
      const pinDoc = await pinRef.get();
      if (!pinDoc.exists) return response.status(401).send({ error: "PIN not set for this account." });
      const { hashedPin } = pinDoc.data();
      const pinMatch = await bcrypt.compare(pin, hashedPin);
      if (!pinMatch) return response.status(401).send({ error: "Invalid PIN." });

      const rawPinSignerPrivateKey = pinSignerPrivateKey.value();
      const rawPinSignerAccountId = pinSignerAccountId.value();
      if (!rawPinSignerPrivateKey || !rawPinSignerAccountId) {
        console.error("Missing PIN signer secrets:", { hasPinSignerKey: !!rawPinSignerPrivateKey, hasPinSignerAccountId: !!rawPinSignerAccountId });
        return response.status(500).send({ error: "Server signing credentials are not configured." });
      }
      let signerKey;
      try { signerKey = PrivateKey.fromStringED25519(rawPinSignerPrivateKey); } catch (err) { console.error("PIN signer key parse failed:", err); return response.status(500).send({ error: "PIN signer private key invalid format." }); }

      const signerAccount = rawPinSignerAccountId.toString();
      const client = Client.forTestnet().setOperator(signerAccount, signerKey);

      // Build Hedera contract transaction
      let transaction;
      switch (txType) {
        case "fundEscrow": {
          const { escrowContractId, tokenId, amountHbar } = txParams;
          if (!escrowContractId || (tokenId === undefined || tokenId === null) || (amountHbar === undefined || amountHbar === null)) return response.status(400).send({ error: "fundEscrow requires escrowContractId, tokenId and amountHbar." });
          const amt = Number(amountHbar);
          if (Number.isNaN(amt) || amt <= 0) return response.status(400).send({ error: "Invalid amountHbar." });
          const params = new ContractFunctionParameters().addUint256(Number(tokenId));
          transaction = new ContractExecuteTransaction().setContractId(escrowContractId).setGas(200_000).setFunction("fundEscrow", params).setPayableAmount(new Hbar(amt));
          break;
        }
        case "confirmDelivery": {
          const { escrowContractId, tokenId } = txParams;
          if (!escrowContractId || (tokenId === undefined || tokenId === null)) return response.status(400).send({ error: "confirmDelivery requires escrowContractId and tokenId." });
          const params = new ContractFunctionParameters().addUint256(Number(tokenId));
          transaction = new ContractExecuteTransaction().setContractId(escrowContractId).setGas(200_000).setFunction("confirmDelivery", params);
          break;
        }
        default:
          return response.status(400).send({ error: `Unsupported txType: ${txType}` });
      }

      const frozenTx = await transaction.freezeWith(client);
      const signedTx = await frozenTx.sign(signerKey);
      const txResponse = await signedTx.execute(client);
      const receipt = await txResponse.getReceipt(client);

      // Audit log
      const transactionId = txResponse.transactionId.toString();
      await db.collection("signLogs").doc(transactionId).set({
        accountId, txType, txParams, signer: signerAccount, transactionId,
        submittedAt: admin.firestore.FieldValue.serverTimestamp(), mirrorStatus: "pending", receiptStatus: receipt.status.toString(),
      });

      return response.status(200).send({ success: true, transactionId, receiptSummary: { status: receipt.status.toString() } });
    } catch (error) {
      console.error("ERROR in signWithPin:", error && error.stack ? error.stack : error);
      return response.status(500).send({ error: "An internal error occurred.", details: String(error?.message || error) });
    }
  });
});

// ---------------------- revokePin, getSignLog (unchanged) ----------------------
exports.revokePin = onRequest({ secrets: [adminAuthToken] }, (request, response) => {
  cors(request, response, async () => {
    if (request.method !== "POST") return response.status(405).send("Method Not Allowed");
    try {
      const { accountId, adminToken } = request.body;
      if (adminToken !== adminAuthToken.value()) return response.status(401).send({ error: "Unauthorized." });
      if (!accountId) return response.status(400).send({ error: "Missing accountId." });
      await db.collection("pins").doc(accountId).delete();
      console.log(`SUCCESS: PIN revoked for account ${accountId}.`);
      return response.status(200).send({ success: true });
    } catch (error) {
      console.error("ERROR in revokePin function:", error);
      return response.status(500).send({ error: "An internal error occurred." });
    }
  });
});

exports.getSignLog = onRequest({ secrets: [adminAuthToken] }, (request, response) => {
  cors(request, response, async () => {
    if (request.method !== "GET") return response.status(405).send("Method Not Allowed");
    try {
      const { accountId, adminToken } = request.query;
      if (adminToken !== adminAuthToken.value()) return response.status(401).send({ error: "Unauthorized." });
      if (!accountId) return response.status(400).send({ error: "Missing accountId." });
      const logsRef = db.collection("signLogs").where("accountId", "==", accountId);
      const snapshot = await logsRef.get();
      if (snapshot.empty) return response.status(200).send([]);
      const logs = [];
      snapshot.forEach(doc => logs.push(doc.data()));
      return response.status(200).send(logs);
    } catch (error) {
      console.error("ERROR in getSignLog function:", error);
      return response.status(500).send({ error: "An internal error occurred." });
    }
  });
});

// ---------------------- NEW: USSD wrapper endpoints ----------------------

// Create a pending listing (seller -> PENDING_VERIFICATION)
exports.createPendingListing = onRequest({ secrets: [hederaAdminAccountId, hederaAdminPrivateKey] }, (request, response) => {
  cors(request, response, async () => {
    if (request.method !== "POST") return response.status(405).send({ error: "Method Not Allowed" });
    try {
      const { sellerAccountId, title, description, priceHbar, assetMetadata } = request.body;
      if (!sellerAccountId || !title || !priceHbar || !assetMetadata) return response.status(400).send({ error: "Missing required fields." });

      // listingId
      const listingId = `LST_${Date.now().toString(36)}`;

      const listingDoc = {
        listingId,
        sellerAccountId,
        title,
        description: description || "",
        priceHbar: Number(priceHbar),
        assetMetadata,
        state: "PENDING_VERIFICATION",
        tokenId: null,
        serialNumber: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        hcsAnchors: []
      };

      await db.collection("listings").doc(listingId).set(listingDoc);

      // HCS anchor (ussd topic)
      const client = await getAdminClient();
      const hcsMsg = { type: "ListingCreated", listingId, sellerAccountId, title, priceHbar: Number(priceHbar), timestamp: new Date().toISOString() };
      const anchor = await anchorToHcs(client, DEFAULT_USSD_HCS_DOC, hcsMsg);

      // Save anchor
      await db.collection("listings").doc(listingId).update({
        "hcsAnchors": admin.firestore.FieldValue.arrayUnion(anchor)
      });

      return response.status(200).send({ success: true, listingId, anchor });
    } catch (error) {
      console.error("ERROR in createPendingListing:", error);
      return response.status(500).send({ error: String(error?.message || error) });
    }
  });
});

// Get listings (optionally filter by state)
exports.getListings = onRequest((request, response) => {
  cors(request, response, async () => {
    if (request.method !== "GET") return response.status(405).send({ error: "Method Not Allowed" });
    try {
      const { state } = request.query;
      let q = db.collection("listings");
      if (state) q = q.where("state", "==", state);
      const snapshot = await q.orderBy("createdAt", "desc").limit(100).get();
      const out = [];
      snapshot.forEach(doc => out.push(doc.data()));
      return response.status(200).send(out);
    } catch (error) {
      console.error("ERROR in getListings:", error);
      return response.status(500).send({ error: String(error?.message || error) });
    }
  });
});

// Get single listing by id
exports.getListing = onRequest((request, response) => {
  cors(request, response, async () => {
    if (request.method !== "GET") return response.status(405).send({ error: "Method Not Allowed" });
    try {
      const listingId = request.path.split("/").pop() || request.query.id;
      if (!listingId) return response.status(400).send({ error: "Missing listing id" });
      const doc = await db.collection("listings").doc(listingId).get();
      if (!doc.exists) return response.status(404).send({ error: "Not found" });
      return response.status(200).send(doc.data());
    } catch (error) {
      console.error("ERROR in getListing:", error);
      return response.status(500).send({ error: String(error?.message || error) });
    }
  });
});

// buyNow (USSD): create purchase in Firestore and return purchaseId.
// Frontend/caller should then call signWithPin to fund the escrow contract using PPSSS.
exports.buyNow = onRequest({ secrets: [hederaAdminAccountId, hederaAdminPrivateKey] }, (request, response) => {
  cors(request, response, async () => {
    if (request.method !== "POST") return response.status(405).send({ error: "Method Not Allowed" });
    try {
      const { listingId, buyerAccountId, escrowContractId, amountHbar } = request.body;
      if (!listingId || !buyerAccountId || !escrowContractId || (amountHbar === undefined || amountHbar === null)) return response.status(400).send({ error: "Missing required fields." });

      // fetch listing
      const listingRef = db.collection("listings").doc(listingId);
      const listingSnap = await listingRef.get();
      if (!listingSnap.exists) return response.status(404).send({ error: "Listing not found." });
      const listing = listingSnap.data();

      // create purchase
      const purchaseId = `PUR_${Date.now().toString(36)}`;
      const purchaseDoc = {
        purchaseId,
        listingId,
        buyerAccountId,
        sellerAccountId: listing.sellerAccountId,
        escrowContractId,
        amountHbar: Number(amountHbar),
        state: "AWAITING_FUNDING", // AWAITING_FUNDING -> FUNDED -> SOLD
        fundTxId: null,
        confirmTxId: null,
        nftTransferTxId: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      await db.collection("purchases").doc(purchaseId).set(purchaseDoc);

      // anchor purchase to HCS (ussd)
      const client = await getAdminClient();
      const hcsMsg = { type: "EscrowPurchaseCreated", purchaseId, listingId, buyerAccountId, sellerAccountId: listing.sellerAccountId, amountHbar: Number(amountHbar), timestamp: new Date().toISOString() };
      const anchor = await anchorToHcs(client, DEFAULT_USSD_HCS_DOC, hcsMsg);

      // update purchase with anchor
      await db.collection("purchases").doc(purchaseId).update({ hcsAnchors: admin.firestore.FieldValue.arrayUnion(anchor) });

      // return purchaseId and instructions: caller should call signWithPin with txType fundEscrow and txParams { escrowContractId, tokenId, amountHbar }
      return response.status(200).send({ success: true, purchaseId, message: "Purchase created. Call signWithPin (fundEscrow) to fund escrow.", anchor });
    } catch (error) {
      console.error("ERROR in buyNow:", error);
      return response.status(500).send({ error: String(error?.message || error) });
    }
  });
});

// confirmDelivery (USSD wrapper) - this will attempt to finalize the purchase flow:
//  - expects confirmDelivery contract to have been executed (by signWithPin or web) to release funds
//  - then transfers NFT from seller -> buyer using performNativeNftTransfer
//  - anchors DeliveryConfirmed to HCS and updates purchase & listing
exports.confirmDelivery = onRequest({ secrets: [hederaAdminAccountId, hederaAdminPrivateKey] }, (request, response) => {
  cors(request, response, async () => {
    if (request.method !== "POST") return response.status(405).send({ error: "Method Not Allowed" });
    try {
      const { purchaseId, serialNumber, sellerPrivateKey } = request.body;
      if (!purchaseId || (serialNumber === undefined || serialNumber === null)) return response.status(400).send({ error: "Missing purchaseId or serialNumber." });

      const purchaseRef = db.collection("purchases").doc(purchaseId);
      const purchaseSnap = await purchaseRef.get();
      if (!purchaseSnap.exists) return response.status(404).send({ error: "Purchase not found." });
      const purchase = purchaseSnap.data();
      if (purchase.state === "SOLD") return response.status(400).send({ error: "Purchase already completed." });

      // perform NFT transfer from seller -> buyer
      const transferResult = await performNativeNftTransfer({
        sellerAccountId: purchase.sellerAccountId,
        buyerAccountId: purchase.buyerAccountId,
        serialNumber,
        sellerPrivateKey // optional: if caller provides seller key, attempt allowance step
      });

      // update purchase state
      await purchaseRef.update({
        state: "SOLD",
        nftTransferTxId: transferResult.transactionId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // update listing state
      const listingRef = db.collection("listings").doc(purchase.listingId);
      await listingRef.update({ state: "SOLD", serialNumber, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

      // anchor DeliveryConfirmed event
      const client = await getAdminClient();
      const hcsMsg = { type: "DeliveryConfirmed", purchaseId, listingId: purchase.listingId, buyerAccountId: purchase.buyerAccountId, sellerAccountId: purchase.sellerAccountId, serialNumber, transferTxId: transferResult.transactionId, timestamp: new Date().toISOString() };
      const anchor = await anchorToHcs(client, DEFAULT_USSD_HCS_DOC, hcsMsg);

      // append anchor to purchase doc
      await purchaseRef.update({ hcsAnchors: admin.firestore.FieldValue.arrayUnion(anchor) });

      return response.status(200).send({ success: true, transferTxId: transferResult.transactionId, anchor });
    } catch (error) {
      console.error("ERROR in confirmDelivery:", error);
      return response.status(500).send({ error: String(error?.message || error) });
    }
  });
});

// ---------------------- NEW: Agent Onboarding ----------------------
exports.createAgent = onRequest({ secrets: [hederaAdminAccountId, hederaAdminPrivateKey] }, (request, response) => {
  cors(request, response, async () => {
    if (request.method !== "POST") return response.status(405).send({ error: "Method Not Allowed" });
    try {
      const { accountId, displayName, role, contact } = request.body;
      if (!accountId || !displayName || !role) return response.status(400).send({ error: "Missing required fields: accountId, displayName, role." });

      const agentId = `AGT_${Date.now().toString(36)}`;
      const agentDoc = {
        agentId,
        accountId,
        displayName,
        role,
        contact: contact || {},
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };
      await db.collection("agents").doc(agentId).set(agentDoc);

      // Anchor AgentCreated to HCS
      const client = await getAdminClient();
      const hcsMsg = { type: "AgentCreated", agentId, accountId, role, displayName, contact, timestamp: new Date().toISOString() };
      const anchor = await anchorToHcs(client, DEFAULT_USSD_HCS_DOC, hcsMsg);

      // save anchor
      await db.collection("agents").doc(agentId).update({ hcsAnchor: anchor });

      return response.status(200).send({ success: true, agentId, anchor });
    } catch (error) {
      console.error("ERROR in createAgent:", error);
      return response.status(500).send({ error: String(error?.message || error) });
    }
  });
});