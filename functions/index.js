// functions/index.js
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const cors = require("cors")({ origin: true });
const crypto = require("crypto");
const bcrypt = require("bcrypt");
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
  AccountAllowanceApproveTransaction
} = require("@hashgraph/sdk");
const ethers = require("ethers");

// Initialize Firebase Admin SDK
admin.initializeApp();
const db = admin.firestore();

// Register new endpoints
require('./ussd');
require('./agent');

// Define secrets
const hederaAdminAccountId = defineSecret('HEDERA_ADMIN_ACCOUNT_ID');
const hederaAdminPrivateKey = defineSecret('HEDERA_ADMIN_PRIVATE_KEY');
const hederaAdminSupplyKey = defineSecret('HEDERA_ADMIN_SUPPLY_KEY');
const pinSignerPrivateKey = defineSecret('PIN_SIGNER_PRIVATE_KEY');
const pinSignerAccountId = defineSecret('PIN_SIGNER_ACCOUNT_ID');
const adminAuthToken = defineSecret('ADMIN_AUTH_TOKEN');

// --- Configuration ---
const assetTokenContractId = "0.0.7134449";

// Utility: Validate EVM address (no ENS, no malformed)
function isValidEvmAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

// Utility: Convert Hedera AccountId to EVM address
function toEvmAddress(accountIdString) {
  if (isValidEvmAddress(accountIdString)) {
    return accountIdString;
  }
  try {
    return `0x${AccountId.fromString(accountIdString).toSolidityAddress()}`;
  } catch (e) {
    return null;
  }
}

// ---------------------- Account Factory / DID Anchoring ----------------------
exports.createAccount = onRequest({ secrets: [hederaAdminAccountId, hederaAdminPrivateKey] }, (request, response) => {
  cors(request, response, async () => {
    if (request.method !== "POST") {
      return response.status(405).send("Method Not Allowed");
    }

    try {
      // Admin credentials
      const adminAccountId = hederaAdminAccountId.value();
      const rawAdminPrivateKey = hederaAdminPrivateKey.value();

      if (!adminAccountId || !rawAdminPrivateKey) {
        throw new Error("Admin credentials are not set as secrets.");
      }

      const adminPrivateKey = PrivateKey.fromStringECDSA(rawAdminPrivateKey);

      // Hedera client
      const client = Client.forTestnet().setOperator(adminAccountId, adminPrivateKey);

      // Generate new ECDSA keypair
      const newPriv = PrivateKey.generateECDSA();
      const newPrivHex0x = "0x" + newPriv.toStringRaw();
      const newPubKey = newPriv.publicKey;

      // Create new account
      const acctTx = new AccountCreateTransaction()
        .setKey(newPubKey)
        .setInitialBalance(new Hbar(65));
      const acctSubmit = await acctTx.execute(client);
      const acctReceipt = await acctSubmit.getReceipt(client);
      const newAccountId = acctReceipt.accountId;
      if (!newAccountId) throw new Error("Failed to create account; no account id returned.");

      // Derive EVM address
      const evmAddress = (new ethers.Wallet(newPrivHex0x)).address;

      // --- DID Anchoring ---
      const didDoc = {
        id: "", // will be set below
        controller: newAccountId.toString(),
        evmAddress,
        publicKeyHex: newPubKey.toStringRaw(),
        created: new Date().toISOString()
      };

      // Compute DID hash and id
      const initialDidDocJson = JSON.stringify(didDoc);
      const initialDidHash = crypto.createHash("sha256").update(initialDidDocJson).digest("hex");
      const did = `did:integro:${initialDidHash.substring(0, 16)}`;
      didDoc.id = did;

      const finalDidDocJson = JSON.stringify(didDoc);
      const finalDidHash = crypto.createHash("sha256").update(finalDidDocJson).digest("hex");

      // Get HCS topic for DID anchoring
      let topicId = process.env.HCS_DID_TOPIC_ID;
      const configRef = db.collection('config').doc('didTopic');

      if (!topicId) {
        const doc = await configRef.get();
        if (doc.exists) {
          topicId = doc.data().topicId;
        } else {
          const createTopicTx = await new TopicCreateTransaction().execute(client);
          const createTopicReceipt = await createTopicTx.getReceipt(client);
          topicId = createTopicReceipt.topicId.toString();
          await configRef.set({ topicId });
        }
      }

      // Submit DID document or its hash to HCS (size guard)
      const message = finalDidDocJson.length > 1024 ? finalDidHash : finalDidDocJson;
      const submitMessageTx = await new TopicMessageSubmitTransaction({
        topicId,
        message
      }).execute(client);

      const submitMessageReceipt = await submitMessageTx.getReceipt(client);
      const consensusTimestamp = submitMessageReceipt?.consensusTimestamp?.toString() || null;

      const didAnchor = {
        topicId,
        transactionId: submitMessageTx.transactionId.toString(),
        consensusTimestamp
      };

      // Save DID document in Firestore
      await db.collection('dids').doc(did).set({
        doc: didDoc,
        accountId: newAccountId.toString(),
        evmAddress,
        anchored: didAnchor,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Response (do not log private keys in production)
      return response.status(200).send({
        accountId: newAccountId.toString(),
        privateKey: newPrivHex0x,
        evmAddress,
        did,
        didAnchor
      });

    } catch (error) {
      console.error("FATAL ERROR in createAccount function:", error);
      return response.status(500).send({ error: error.message });
    }
  });
});

// ---------------------- Native NFT transfer (admin-assisted) ----------------------
exports.executeNativeNftTransfer = onRequest({ secrets: [hederaAdminAccountId, hederaAdminPrivateKey] }, (request, response) => {
  cors(request, response, async () => {
    if (request.method !== "POST") {
      return response.status(405).send("Method Not Allowed");
    }

    try {
      const { sellerAccountId, buyerAccountId, serialNumber, sellerPrivateKey } = request.body;
      if (!sellerAccountId || !buyerAccountId || (serialNumber === undefined || serialNumber === null)) {
        throw new Error("Missing required fields: sellerAccountId, buyerAccountId, serialNumber.");
      }

      const adminId = hederaAdminAccountId.value();
      const rawAdminPrivateKey = hederaAdminPrivateKey.value();
      if (!rawAdminPrivateKey || !adminId) {
        throw new Error("Admin credentials are not set as secrets.");
      }
      const adminPrivateKey = PrivateKey.fromStringECDSA(rawAdminPrivateKey);
      const client = Client.forTestnet().setOperator(adminId, adminPrivateKey);

      const assetTokenId = assetTokenContractId; // keep consistent with your config

      // If sellerPrivateKey is supplied, attempt to create an allowance so admin can transfer the seller's NFT.
      if (sellerPrivateKey) {
        try {
          // Normalize seller key and construct PrivateKey object
          let sellerKeyInput = sellerPrivateKey;
          if (typeof sellerKeyInput !== 'string') {
            throw new Error("sellerPrivateKey must be a string.");
          }
          if (sellerKeyInput.startsWith('0x')) sellerKeyInput = sellerKeyInput.slice(2);

          let sellerPrivateKeyObj;
          try {
            // prefer ECDSA parse for hex keys
            sellerPrivateKeyObj = PrivateKey.fromStringECDSA(sellerKeyInput);
          } catch (errECDSA) {
            // fallback: try generic parsing (could be DER / other)
            try {
              sellerPrivateKeyObj = PrivateKey.fromString(sellerPrivateKey);
            } catch (errGeneric) {
              throw new Error("Failed to parse sellerPrivateKey (not valid ECDSA hex or recognized DER/format).");
            }
          }

          // Build a client with seller as operator so seller can sign the allowance
          const sellerClient = Client.forTestnet().setOperator(sellerAccountId, sellerPrivateKeyObj);

          // Approve the admin (spender) for the specific serial number
          const approveTx = await new AccountAllowanceApproveTransaction()
            .approveTokenNftAllowance(assetTokenId, sellerAccountId, adminId, [Number(serialNumber)])
            .freezeWith(sellerClient);

          const signedApprove = await approveTx.sign(sellerPrivateKeyObj);
          const approveSubmit = await signedApprove.execute(sellerClient);
          const approveReceipt = await approveSubmit.getReceipt(sellerClient);

          console.log(`Allowance receipt status: ${approveReceipt.status.toString()}`);
        } catch (allowErr) {
          const msg = String(allowErr && allowErr.message ? allowErr.message : allowErr);
          console.warn("Allowance step failed:", msg);

          const tolerantPatterns = [
            "ALREADY",
            "already approved",
            "TOKEN_ALREADY_APPROVED",
            "ALREADY_EXISTS",
            "ACCOUNT_ALREADY_APPROVED"
          ];
          const isTolerable = tolerantPatterns.some(p => msg.toLowerCase().includes(p.toLowerCase()));

          if (!isTolerable) {
            console.error("Non-tolerable allowance error:", allowErr);
            return response.status(500).send({ error: `Failed to create allowance: ${msg}` });
          } else {
            console.log("Allowance likely already present — continuing to transfer.");
          }
        }
      } else {
        console.log("No sellerPrivateKey provided — attempting admin-signed transfer (requires pre-approved allowance).");
      }

      // Build & freeze transfer transaction (signed and submitted by admin)
      const transferTxFrozen = await new TransferTransaction()
        .addNftTransfer(assetTokenId, Number(serialNumber), sellerAccountId, buyerAccountId)
        .freezeWith(client);

      // Sign with admin (explicit)
      const signedTransferTx = await transferTxFrozen.sign(adminPrivateKey);

      // Submit the transfer
      const transferTxSubmit = await signedTransferTx.execute(client);
      const transferRx = await transferTxSubmit.getReceipt(client);

      if (transferRx.status.toString() !== 'SUCCESS') {
        throw new Error(`NFT transfer failed with status: ${transferRx.status.toString()}`);
      }

      return response.status(200).send({
        success: true,
        transactionId: transferTxSubmit.transactionId.toString()
      });

    } catch (error) {
      console.error("ERROR in executeNativeNftTransfer:", error);
      return response.status(500).send({ error: String(error.message || error) });
    }
  });
});

// ---------------------- Mint RWA via USSD (existing working flow) ----------------------
exports.mintRWAviaUSSD = onRequest({
  secrets: [hederaAdminAccountId, hederaAdminPrivateKey, hederaAdminSupplyKey]
}, (request, response) => {
  cors(request, response, async () => {
    if (request.method !== "POST") {
      return response.status(405).send("Method Not Allowed");
    }
    try {
      const { accountId, assetType, quality, location } = request.body;
      if (!accountId || !assetType || !quality || !location) {
        throw new Error("Missing required fields: accountId, assetType, quality, location.");
      }

      const adminId = hederaAdminAccountId.value();
      const rawAdminPrivateKey = hederaAdminPrivateKey.value();
      const rawSupplyKey = hederaAdminSupplyKey.value();

      if (!rawAdminPrivateKey || !adminId || !rawSupplyKey) {
        throw new Error("Admin credentials or supply key are not set as secrets.");
      }

      const adminPrivateKey = PrivateKey.fromStringECDSA(rawAdminPrivateKey);
      const supplyPrivateKey = PrivateKey.fromStringED25519(rawSupplyKey);

      const client = Client.forTestnet().setOperator(adminId, adminPrivateKey);

      const metadata = Buffer.from(JSON.stringify({ assetType, quality, location }));
      if (metadata.length > 100) {
        throw new Error("Metadata exceeds 100 bytes limit.");
      }

      const mintTx = await new TokenMintTransaction()
        .setTokenId(assetTokenContractId)
        .setMetadata([metadata])
        .freezeWith(client);

      const signedMintTx = await mintTx.sign(supplyPrivateKey);
      const mintTxSubmit = await signedMintTx.execute(client);
      const mintRx = await mintTxSubmit.getReceipt(client);

      if (!mintRx.serials || mintRx.serials.length === 0) {
        throw new Error("Minting succeeded but no serial number was returned.");
      }

      const serialNumber = Number(mintRx.serials[0].toString());

      const transferTx = await new TransferTransaction()
        .addNftTransfer(assetTokenContractId, serialNumber, adminId, accountId)
        .freezeWith(client)
        .execute(client);

      const transferRx = await transferTx.getReceipt(client);

      if (transferRx.status.toString() !== 'SUCCESS') {
        throw new Error(`NFT transfer failed with status: ${transferRx.status.toString()}`);
      }

      console.log(`SUCCESS: RWA minted and transferred to user ${accountId}. New Serial Number: ${serialNumber}.`);
      return response.status(200).send({
        tokenId: assetTokenContractId,
        serialNumber: serialNumber
      });

    } catch (error) {
      if (error.message && error.message.includes("ACCOUNT_KYC_NOT_GRANTED_FOR_TOKEN")) {
        return response.status(400).send({ error: "User account must be KYC'd and associated with the token before minting." });
      }
      if (error.message && error.message.includes("INVALID_SIGNATURE")) {
        console.error("Signature error details:", {
          hasAdminKey: !!hederaAdminPrivateKey.value(),
          hasSupplyKey: !!hederaAdminSupplyKey.value(),
          tokenId: assetTokenContractId
        });
        return response.status(400).send({
          error: "Invalid signature. Check that supply key matches the token's supply key and all keys are correct."
        });
      }
      if (error.message && error.message.includes("INVALID_TOKEN_ID")) {
        return response.status(400).send({ error: "Invalid token ID. Check assetTokenContractId." });
      }
      if (error.message && error.message.includes("INSUFFICIENT_TX_FEE")) {
        return response.status(400).send({ error: "Insufficient transaction fee. Try increasing the gas limit or check your account balance." });
      }
      console.error("ERROR minting RWA via USSD:", error);
      return response.status(500).send({ error: error.message });
    }
  });
});

// ---------------------- Profile (simple) ----------------------
exports.setUserProfile = onRequest((request, response) => {
  cors(request, response, async () => {
    if (request.method !== "POST") {
      return response.status(405).send("Method Not Allowed");
    }

    try {
      const { accountId, displayName, role, location } = request.body;
      if (!accountId || !displayName || !role || !location) {
        return response.status(400).send({ error: "Missing required profile fields." });
      }

      const profileRef = db.collection("profiles").doc(accountId);

      await profileRef.set({
        displayName,
        role,
        location,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

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
    if (request.method !== "POST") {
      return response.status(405).send("Method Not Allowed");
    }

    try {
      const { accountId, pin } = request.body;

      if (!accountId || !pin) {
        return response.status(400).send({ error: "Missing accountId or pin." });
      }
      if (typeof pin !== 'string' || pin.length < 4 || pin.length > 6 || !/^\d+$/.test(pin)) {
        return response.status(400).send({ error: "PIN must be a string of 4-6 digits." });
      }

      const saltRounds = 12;
      const hashedPin = await bcrypt.hash(pin, saltRounds);

      const pinRef = db.collection("pins").doc(accountId);
      await pinRef.set({
        hashedPin,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

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
    if (request.method !== "POST") {
      return response.status(405).send({ error: "Method Not Allowed" });
    }

    try {
      const { accountId, pin, txType, txParams } = request.body;

      // Basic input validation
      if (!accountId || !pin || !txType || !txParams) {
        return response.status(400).send({ error: "Missing required fields: accountId, pin, txType, txParams." });
      }

      // Rate limiting (15-minute window)
      const attemptsDocRef = db.collection('pinAttempts').doc(accountId);
      const attemptsDoc = await attemptsDocRef.get();
      const now = Date.now();
      const windowStart = now - (15 * 60 * 1000); // 15 minutes
      if (attemptsDoc.exists) {
        const data = attemptsDoc.data();
        const recentAttempts = Array.isArray(data.attempts) ? data.attempts.filter(ts => ts > windowStart) : [];
        if (recentAttempts.length >= 5) {
          return response.status(429).send({ error: "Too many attempts. Please try again later." });
        }
        await attemptsDocRef.update({ attempts: [...recentAttempts, now] });
      } else {
        await attemptsDocRef.set({ attempts: [now] });
      }

      // Verify PIN
      const pinRef = db.collection("pins").doc(accountId);
      const pinDoc = await pinRef.get();
      if (!pinDoc.exists) {
        return response.status(401).send({ error: "PIN not set for this account." });
      }
      const { hashedPin } = pinDoc.data();
      const pinMatch = await bcrypt.compare(pin, hashedPin);
      if (!pinMatch) return response.status(401).send({ error: "Invalid PIN." });

      // --- Server signing credentials ---
      const rawPinSignerPrivateKey = pinSignerPrivateKey.value();
      const rawPinSignerAccountId = pinSignerAccountId.value();

      if (!rawPinSignerPrivateKey || !rawPinSignerAccountId) {
        console.error("Missing PIN signer secrets:", {
          hasPinSignerKey: !!rawPinSignerPrivateKey,
          hasPinSignerAccountId: !!rawPinSignerAccountId
        });
        return response.status(500).send({ error: "Server signing credentials are not configured." });
      }

      // Build signer key and client
      let signerKey;
      try {
        signerKey = PrivateKey.fromStringED25519(rawPinSignerPrivateKey);
      } catch (err) {
        console.error("Failed to parse PIN signer private key:", err);
        return response.status(500).send({ error: "PIN signer private key invalid format." });
      }

      const signerAccount = rawPinSignerAccountId.toString();
      const client = Client.forTestnet().setOperator(signerAccount, signerKey);

      // Build transaction based on txType
      let transaction;
      switch (txType) {
        case "fundEscrow": {
          const { escrowContractId, tokenId, amountHbar } = txParams;
          if (!escrowContractId || (tokenId === undefined || tokenId === null) || (amountHbar === undefined || amountHbar === null)) {
            return response.status(400).send({ error: "fundEscrow requires escrowContractId, tokenId and amountHbar." });
          }
          const amt = Number(amountHbar);
          if (Number.isNaN(amt) || amt <= 0) {
            return response.status(400).send({ error: "Invalid amountHbar." });
          }

          const params = new ContractFunctionParameters()
            .addUint256(Number(tokenId)); // tokenId must be numeric

          transaction = new ContractExecuteTransaction()
            .setContractId(escrowContractId)
            .setGas(200_000)
            .setFunction("fundEscrow", params)
            .setPayableAmount(new Hbar(amt));
          break;
        }
        case "confirmDelivery": {
          const { escrowContractId, tokenId } = txParams;
          if (!escrowContractId || (tokenId === undefined || tokenId === null)) {
            return response.status(400).send({ error: "confirmDelivery requires escrowContractId and tokenId." });
          }

          const params = new ContractFunctionParameters()
            .addUint256(Number(tokenId));

          transaction = new ContractExecuteTransaction()
            .setContractId(escrowContractId)
            .setGas(200_000)
            .setFunction("confirmDelivery", params);
          break;
        }
        default:
          return response.status(400).send({ error: `Unsupported txType: ${txType}` });
      }

      // Freeze -> sign -> execute
      const frozenTx = await transaction.freezeWith(client);
      const signedTx = await frozenTx.sign(signerKey);
      const txResponse = await signedTx.execute(client);
      const receipt = await txResponse.getReceipt(client);

      // Audit log
      const transactionId = txResponse.transactionId.toString();
      await db.collection("signLogs").doc(transactionId).set({
        accountId,
        txType,
        txParams,
        signer: signerAccount,
        transactionId,
        submittedAt: admin.firestore.FieldValue.serverTimestamp(),
        mirrorStatus: "pending",
        receiptStatus: receipt.status.toString(),
      });

      return response.status(200).send({
        success: true,
        transactionId,
        receiptSummary: { status: receipt.status.toString() }
      });

    } catch (error) {
      console.error("ERROR in signWithPin:", error && error.stack ? error.stack : error);
      return response.status(500).send({ error: "An internal error occurred.", details: String(error?.message || error) });
    }
  });
});

// ---------------------- Revoke PIN ----------------------
exports.revokePin = onRequest({ secrets: [adminAuthToken] }, (request, response) => {
  cors(request, response, async () => {
    if (request.method !== "POST") {
      return response.status(405).send("Method Not Allowed");
    }

    try {
      const { accountId, adminToken } = request.body;

      if (adminToken !== adminAuthToken.value()) {
        return response.status(401).send({ error: "Unauthorized." });
      }

      if (!accountId) {
        return response.status(400).send({ error: "Missing accountId." });
      }

      const pinRef = db.collection("pins").doc(accountId);
      await pinRef.delete();

      console.log(`SUCCESS: PIN revoked for account ${accountId}.`);
      return response.status(200).send({ success: true });

    } catch (error) {
      console.error("ERROR in revokePin function:", error);
      return response.status(500).send({ error: "An internal error occurred." });
    }
  });
});

// ---------------------- Get SignLog ----------------------
exports.getSignLog = onRequest({ secrets: [adminAuthToken] }, (request, response) => {
  cors(request, response, async () => {
    if (request.method !== "GET") {
      return response.status(405).send("Method Not Allowed");
    }

    try {
      const { accountId, adminToken } = request.query;

      if (adminToken !== adminAuthToken.value()) {
        return response.status(401).send({ error: "Unauthorized." });
      }

      if (!accountId) {
        return response.status(400).send({ error: "Missing accountId." });
      }

      const logsRef = db.collection("signLogs").where("accountId", "==", accountId);
      const snapshot = await logsRef.get();

      if (snapshot.empty) {
        return response.status(200).send([]);
      }

      const logs = [];
      snapshot.forEach(doc => {
        logs.push(doc.data());
      });

      return response.status(200).send(logs);

    } catch (error) {
      console.error("ERROR in getSignLog function:", error);
      return response.status(500).send({ error: "An internal error occurred." });
    }
  });
});