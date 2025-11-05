const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require('firebase-functions/params');
const admin = require("firebase-admin");
const {
  Client,
  PrivateKey,
  AccountCreateTransaction,
  Hbar,
  PublicKey,
  AccountId,
  TokenMintTransaction,
  TransferTransaction,
  AccountAllowanceApproveTransaction,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  TokenAssociateTransaction
} = require("@hashgraph/sdk");
const cors = require("cors")({ origin: true });
const ethers = require("ethers");

// Initialize Firebase Admin SDK
admin.initializeApp();
const db = admin.firestore();

// --- Add this helper function ---
const sendSms = async (accountId, message) => {
  // We use the accountId as the document ID for the user's inbox
  const inboxRef = db.collection('sms_inbox').doc(accountId).collection('messages');
  await inboxRef.add({
    message: message,
    timestamp: admin.firestore.FieldValue.serverTimestamp()
  });
};

// Define secrets
const hederaAdminAccountId = defineSecret('HEDERA_ADMIN_ACCOUNT_ID');
const hederaAdminPrivateKey = defineSecret('HEDERA_ADMIN_PRIVATE_KEY');
const hederaAdminSupplyKey =
  defineSecret('HEDERA_ADMIN_SUPPLY_KEY');
// --- Configuration ---
const assetTokenContractId = "0.0.7134449";
const assetTokenId = "0.0.7134449";
const escrowContractId = "0.0.7134455";


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
    // The SDK returns an address WITHOUT the 0x prefix, which our validation function needs.
    return `0x${AccountId.fromString(accountIdString).toSolidityAddress()}`;
  } catch (e) {
    return null;
  }
}

exports.createAccount = onRequest({ secrets: [hederaAdminAccountId, hederaAdminPrivateKey] }, (request, response) => {
  cors(request, response, async () => {
    if (request.method !== "POST") {
      return response.status(405).send("Method Not Allowed");
    }
    try {
      const adminAccountId = hederaAdminAccountId.value();
      const rawAdminPrivateKey = hederaAdminPrivateKey.value();

      if (!adminAccountId || !rawAdminPrivateKey) {
        throw new Error("Admin credentials are not set as secrets in this V2 function environment.");
      }

      const adminPrivateKey = PrivateKey.fromStringECDSA(rawAdminPrivateKey);

      const client = Client.forTestnet();
      client.setOperator(adminAccountId, adminPrivateKey);

      const newPriv = PrivateKey.generateECDSA();
      const newPrivHex0x = "0x" + newPriv.toStringRaw();
      const newPubKey = newPriv.publicKey;

      console.log("createAccount: generated ECDSA privateKey (hex):", newPrivHex0x);

      const acctTx = new AccountCreateTransaction()
        .setKey(newPubKey)
        .setInitialBalance(new Hbar(65));

      const acctSubmit = await acctTx.execute(client);
      const acctReceipt = await acctSubmit.getReceipt(client);
      const newAccountId = acctReceipt.accountId;
      if (!newAccountId) {
        throw new Error("Failed to create account; no account id returned.");
      }
      console.log("createAccount: created accountId:", newAccountId.toString());

      const evmAddress = (new ethers.Wallet(newPrivHex0x)).address;
      console.log("createAccount: derived evmAddress (from ECDSA key):", evmAddress);

      return response.status(200).send({
        accountId: newAccountId.toString(),
        privateKey: newPrivHex0x,
        evmAddress: evmAddress
      });

    } catch (error) {
      console.error("FATAL ERROR in createAccount function:", error);
      return response.status(500).send({ error: error.message });
    }
  });
});

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

      const assetTokenId = "0.0.7134449"; // keep consistent with your config

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

          // Sign with the seller's private key and submit
          const signedApprove = await approveTx.sign(sellerPrivateKeyObj);
          const approveSubmit = await signedApprove.execute(sellerClient);
          const approveReceipt = await approveSubmit.getReceipt(sellerClient);

          console.log(`Allowance receipt status: ${approveReceipt.status.toString()}`);
          // If the receipt status is SUCCESS, proceed. If it returned some other status,
          // we'll log and continue — the admin transfer may still work if allowance is already set.

        } catch (allowErr) {
          // If error indicates allowance already present, ignore and continue.
          // Use string checks because exact SDK error codes vary.
          const msg = String(allowErr && allowErr.message ? allowErr.message : allowErr);
          console.warn("Allowance step failed:", msg);

          // tolerable messages (examples) - ignore and continue
          const tolerantPatterns = [
            "ALREADY", // generic
            "already approved",
            "TOKEN_ALREADY_APPROVED",
            "ALREADY_EXISTS",
            "ACCOUNT_ALREADY_APPROVED"
          ];

          const isTolerable = tolerantPatterns.some(p => msg.toLowerCase().includes(p.toLowerCase()));

          if (!isTolerable) {
            // Non-tolerable error during allowance creation — return a clear error
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
      // Prefer to return structured JSON with message
      return response.status(500).send({ error: String(error.message || error) });
    }
  });
});

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

// --- NEW FUNCTION ---
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

      const db = admin.firestore();
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

// --- USSD Handlers ---
exports.createVault_ussd = onRequest({ secrets: [hederaAdminAccountId, hederaAdminPrivateKey] }, (request, response) => {
  cors(request, response, async () => {
    function verifyPrivateKeyMatchesEvmAddress(privateKeyHex, evmAddress) {
      try {
        const prefixedKey = privateKeyHex.startsWith('0x') ? privateKeyHex : `0x${privateKeyHex}`;
        const wallet = new ethers.Wallet(prefixedKey);
        return wallet.address.toLowerCase() === evmAddress.toLowerCase();
      } catch (error) {
        console.error("Error verifying private key against EVM address:", error);
        return false;
      }
    }
    console.log("createVault_ussd: Received request");
    console.log("Headers:", request.headers);
    console.log("Raw Body:", request.rawBody ? request.rawBody.toString('utf8').substring(0, 100) + '...' : 'N/A');

    if (request.method !== "POST") {
      return response.status(405).send({ error: { message: "Method Not Allowed" } });
    }

    try {
      console.log("Parsed Body:", request.body);
      const adminAccountId = hederaAdminAccountId.value();
      const rawAdminPrivateKey = hederaAdminPrivateKey.value();

      if (!adminAccountId || !rawAdminPrivateKey) {
        console.error("FATAL: Admin credentials are not set.");
        throw new Error("Server configuration error: Admin credentials are not set.");
      }

      const adminPrivateKey = PrivateKey.fromStringECDSA(rawAdminPrivateKey);
      const client = Client.forTestnet().setOperator(adminAccountId, adminPrivateKey);

      const newPriv = PrivateKey.generateECDSA();
      const newPrivHex = newPriv.toStringRaw();
      const newPrivHex0x = "0x" + newPrivHex;
      const newPubKey = newPriv.publicKey;
      console.log("Generated new ECDSA key pair.");

      const acctTx = new AccountCreateTransaction()
        .setKey(newPubKey)
        .setInitialBalance(new Hbar(65));

      const acctSubmit = await acctTx.execute(client);
      const acctReceipt = await acctSubmit.getReceipt(client);
      const newAccountId = acctReceipt.accountId;

      if (!newAccountId) {
        console.error("Account creation failed, receipt did not contain accountId.");
        throw new Error("Failed to create account; no account ID was returned from the network.");
      }
      console.log(`Successfully created new Hedera account: ${newAccountId.toString()}`);

      const evmAddress = (new ethers.Wallet(newPrivHex0x)).address;
      console.log(`Derived EVM address: ${evmAddress}`);

      const isVerified = verifyPrivateKeyMatchesEvmAddress(newPrivHex, evmAddress);
      console.log(`Verification check (private key matches EVM address): ${isVerified}`);
      if (!isVerified) {
        throw new Error("FATAL: Generated private key does not match derived EVM address.");
      }

      return response.status(200).send({
        accountId: newAccountId.toString(),
        privateKey: newPrivHex0x,
        evmAddress: evmAddress
      });

    } catch (error) {
      console.error("FATAL ERROR in createVault_ussd function:", error);
      const status = error.message && error.message.includes("Invalid private key format") ? 400 : 500;
      return response.status(status).send({ error: { message: error.message, details: `Transaction ID: ${error.transactionId}` } });
    }
  });
});

exports.confirmDelivery_ussd = onRequest({ secrets: [] }, (request, response) => {
  cors(request, response, async () => {
    console.log("confirmDelivery_ussd: Received request");
    console.log("Headers:", request.headers);
    console.log("Raw Body:", request.rawBody ? request.rawBody.toString('utf8').substring(0, 100) + '...' : 'N/A');

    if (request.method !== "POST") {
      return response.status(405).send({ error: { message: "Method Not Allowed" } });
    }

    let buyerClient;
    try {
      console.log("Parsed Body:", request.body);
      const { buyerAccountId, buyerPrivateKey, listingId } = request.body;
      if (!buyerAccountId || !buyerPrivateKey || !listingId) {
        return response.status(400).send({
          error: {
            message: "Missing required fields.",
            details: "Requires: buyerAccountId, buyerPrivateKey, listingId."
          }
        });
      }

      const serialNumber = parseInt(listingId.split('-')[1], 10);
      if (isNaN(serialNumber)) {
        return response.status(400).send({ error: { message: "Invalid listingId format." } });
      }

      let rawHexKey;
      try {
        rawHexKey = buyerPrivateKey.startsWith('0x') ? buyerPrivateKey.substring(2) : buyerPrivateKey;
        if (rawHexKey.length !== 64) throw new Error("Invalid length");
        PrivateKey.fromStringECDSA(rawHexKey);
      } catch (e) {
        return response.status(400).send({ error: { message: "Invalid private key format for buyerPrivateKey." } });
      }

      const buyerHederaPrivateKey = PrivateKey.fromStringECDSA(rawHexKey);
      buyerClient = Client.forTestnet().setOperator(buyerAccountId, buyerHederaPrivateKey);

      const confirmTx = await new ContractExecuteTransaction()
        .setContractId(escrowContractId)
        .setGas(1_000_000)
        .setFunction("confirmDelivery", new ContractFunctionParameters().addUint256(serialNumber))
        .freezeWith(buyerClient);

      const signedConfirmTx = await confirmTx.sign(buyerHederaPrivateKey);
      const confirmTxSubmit = await signedConfirmTx.execute(buyerClient);
      const confirmRx = await confirmTxSubmit.getReceipt(buyerClient);

      if (confirmRx.status.toString() !== 'SUCCESS') {
        throw new Error(`Contract execution for confirmDelivery failed with status: ${confirmRx.status.toString()}`);
      }

      console.log(`Delivery confirmed successfully for listing ${listingId}.`);

      await db.collection('listings').doc(listingId).update({
        state: 'DELIVERED'
      });
      console.log(`Firestore state updated to DELIVERED for listing ${listingId}.`);

      const listing = (await db.collection('listings').doc(listingId).get()).data();
      const sellerAccountId = listing.sellerAccountId;

      await sendSms(buyerAccountId, `SUCCESS: Your order ${listingId} is complete!`);
      await sendSms(sellerAccountId, `SUCCESS: You have been paid for ${listingId}.`);

      return response.status(200).send({ success: true });
    } catch (error) {
      console.error("FATAL ERROR in confirmDelivery_ussd function:", error);
      const txId = error.transactionId || (buyerClient ? buyerClient.transactionId : null);
      return response.status(500).send({
        error: {
          message: error.message,
          details: `Transaction ID: ${txId}`.toString()
        }
      });
    }
  });
});

exports.fundEscrow_ussd = onRequest({ secrets: [] }, (request, response) => {
  cors(request, response, async () => {
    console.log("fundEscrow_ussd: Received request");
    console.log("Headers:", request.headers);
    console.log("Raw Body:", request.rawBody ? request.rawBody.toString('utf8').substring(0, 100) + '...' : 'N/A');

    if (request.method !== "POST") {
      return response.status(405).send({ error: { message: "Method Not Allowed" } });
    }

    let buyerClient;
    try {
      console.log("Parsed Body:", request.body);
      const { buyerAccountId, buyerPrivateKey, listingId, amount } = request.body;
      if (!buyerAccountId || !buyerPrivateKey || !listingId || amount === undefined) {
        return response.status(400).send({
          error: {
            message: "Missing required fields.",
            details: "Requires: buyerAccountId, buyerPrivateKey, listingId, amount."
          }
        });
      }

      const serialNumber = parseInt(listingId.split('-')[1], 10);
      if (isNaN(serialNumber)) {
        return response.status(400).send({ error: { message: "Invalid listingId format." } });
      }

      let rawHexKey;
      try {
        rawHexKey = buyerPrivateKey.startsWith('0x') ? buyerPrivateKey.substring(2) : buyerPrivateKey;
        if (rawHexKey.length !== 64) throw new Error("Invalid length");
        PrivateKey.fromStringECDSA(rawHexKey);
      } catch (e) {
        return response.status(400).send({ error: { message: "Invalid private key format for buyerPrivateKey." } });
      }

      const buyerHederaPrivateKey = PrivateKey.fromStringECDSA(rawHexKey);
      buyerClient = Client.forTestnet().setOperator(buyerAccountId, buyerHederaPrivateKey);

      const fundTx = await new ContractExecuteTransaction()
        .setContractId(escrowContractId)
        .setGas(1_000_000)
        .setPayableAmount(new Hbar(amount))
        .setFunction("fundEscrow", new ContractFunctionParameters().addUint256(serialNumber))
        .freezeWith(buyerClient);

      const signedFundTx = await fundTx.sign(buyerHederaPrivateKey);
      const fundTxSubmit = await signedFundTx.execute(buyerClient);
      const fundRx = await fundTxSubmit.getReceipt(buyerClient);

      if (fundRx.status.toString() !== 'SUCCESS') {
        throw new Error(`Contract execution for fundEscrow failed with status: ${fundRx.status.toString()}`);
      }
      console.log(`Escrow funded successfully for listing ${listingId}.`);

      await db.collection('listings').doc(listingId).update({
        state: 'FUNDED',
        buyerAccountId: buyerAccountId
      });
      console.log(`Firestore state updated to FUNDED for listing ${listingId}.`);

      const listing = (await db.collection('listings').doc(listingId).get()).data();
      const sellerAccountId = listing.sellerAccountId;

      await sendSms(buyerAccountId, `SUCCESS: You purchased listing ${listingId}.`);
      await sendSms(sellerAccountId, `NEW ORDER: Your listing ${listingId} was purchased by ${buyerAccountId}.`);

      return response.status(200).send({ success: true });
    } catch (error) {
      console.error("FATAL ERROR in fundEscrow_ussd function:", error);
      const txId = error.transactionId || (buyerClient ? buyerClient.transactionId : null);
      return response.status(500).send({
        error: {
          message: error.message,
          details: `Transaction ID: ${txId}`.toString()
        }
      });
    }
  });
});

exports.listProduct_ussd = onRequest({
  secrets: [hederaAdminAccountId, hederaAdminPrivateKey, hederaAdminSupplyKey]
}, (request, response) => {
  cors(request, response, async () => {
    console.log("listProduct_ussd: Received request");
    console.log("Headers:", request.headers);
    console.log("Raw Body:", request.rawBody ? request.rawBody.toString('utf8').substring(0, 100) + '...' : 'N/A');
    if (request.method !== "POST") {
      return response.status(405).send({ error: { message: "Method Not Allowed" } });
    }
    let sellerClient;
    try {
      console.log("Parsed Body:", request.body);
      const { sellerAccountId, sellerPrivateKey, productName, price, description, location } = request.body;
      if (!sellerAccountId || !sellerPrivateKey || !productName || price === undefined) {
        return response.status(400).send({
          error: {
            message: "Missing required fields.",
            details: "Requires: sellerAccountId, sellerPrivateKey, productName, price."
          }
        });
      }

      let rawHexKey;
      try {
        rawHexKey = sellerPrivateKey.startsWith('0x') ? sellerPrivateKey.substring(2) : sellerPrivateKey;
        if (rawHexKey.length !== 64) throw new Error("Invalid length");
        PrivateKey.fromStringECDSA(rawHexKey);
      } catch (e) {
        return response.status(400).send({ error: { message: "Invalid private key format for sellerPrivateKey." } });
      }

      const sellerHederaPrivateKey = PrivateKey.fromStringECDSA(rawHexKey);
      sellerClient = Client.forTestnet().setOperator(sellerAccountId, sellerHederaPrivateKey);

      const adminId = hederaAdminAccountId.value();
      const rawAdminPrivateKey = hederaAdminPrivateKey.value();

      if (!adminId || !rawAdminPrivateKey) {
        throw new Error("Server configuration error: Admin credentials are not set.");
      }

      try {
        const assocTx = await new TokenAssociateTransaction()
          .setAccountId(sellerAccountId)
          .setTokenIds([assetTokenId])
          .freezeWith(sellerClient);

        const signedAssocTx = await assocTx.sign(sellerHederaPrivateKey);
        const assocTxSubmit = await signedAssocTx.execute(sellerClient);
        const assocRx = await assocTxSubmit.getReceipt(sellerClient);

        if (assocRx.status.toString() !== 'SUCCESS') {
          throw new Error(`Token association failed with status: ${assocRx.status.toString()}`);
        }
        console.log(`Token ${assetTokenId} associated successfully with ${sellerAccountId}.`);

      } catch (error) {
        if (error.message.includes("TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT")) {
          console.log("Token was already associated, continuing.");
        } else {
          throw error;
        }
      }

      const adminClient = Client.forTestnet().setOperator(adminId, PrivateKey.fromStringECDSA(rawAdminPrivateKey));
      const supplyPrivateKey = PrivateKey.fromStringED25519(hederaAdminSupplyKey.value());

      const metadata = Buffer.from(JSON.stringify({ assetType: productName, quality: description || 'N/A', location: location || 'N/A' }));
      if (metadata.length > 100) {
        throw new Error("Metadata for minting exceeds 100 bytes limit.");
      }

      const mintTx = await new TokenMintTransaction()
        .setTokenId(assetTokenId)
        .setMetadata([metadata])
        .freezeWith(adminClient);

      const signedMintTx = await mintTx.sign(supplyPrivateKey);
      const mintTxSubmit = await signedMintTx.execute(adminClient);
      const mintRx = await mintTxSubmit.getReceipt(adminClient);

      if (mintRx.status.toString() !== 'SUCCESS' || !mintRx.serials || mintRx.serials.length === 0) {
        throw new Error(`Minting during listing failed. Status: ${mintRx.status.toString()}`);
      }

      const serialNumber = Number(mintRx.serials[0]);

      const transferTx = await new TransferTransaction()
        .addNftTransfer(assetTokenId, serialNumber, adminId, sellerAccountId)
        .freezeWith(adminClient)
        .execute(adminClient);

      const transferRx = await transferTx.getReceipt(adminClient);
      if (transferRx.status.toString() !== 'SUCCESS') {
        throw new Error(`NFT transfer to seller during listing failed. Status: ${transferRx.status.toString()}`);
      }
      console.log(`Minted new NFT with serial number: ${serialNumber} for listing.`);

      const approveTx = await new AccountAllowanceApproveTransaction()
        .approveTokenNftAllowance(assetTokenId, sellerAccountId, escrowContractId, [serialNumber])
        .freezeWith(sellerClient);

      const signedApproveTx = await approveTx.sign(sellerHederaPrivateKey);
      const approveTxSubmit = await signedApproveTx.execute(sellerClient);
      const approveRx = await approveTxSubmit.getReceipt(sellerClient);
      if (approveRx.status.toString() !== 'SUCCESS') {
        throw new Error(`NFT allowance approval failed with status: ${approveRx.status.toString()}`);
      }
      console.log(`NFT allowance approved for escrow contract ${escrowContractId}.`);

      const priceInTinybars = Math.round(parseFloat(price) * 1e8);

      const listTx = await new ContractExecuteTransaction()
        .setContractId(escrowContractId)
        .setGas(1_000_000)
        .setFunction("listAsset", new ContractFunctionParameters()
          .addUint256(serialNumber)
          .addUint256(priceInTinybars)
        )
        .freezeWith(sellerClient);

      const signedListTx = await listTx.sign(sellerHederaPrivateKey);
      const listTxSubmit = await signedListTx.execute(sellerClient);
      const listRx = await listTxSubmit.getReceipt(sellerClient);
      if (listRx.status.toString() !== 'SUCCESS') {
        throw new Error(`Contract execution for listAsset failed with status: ${listRx.status.toString()}`);
      }
      console.log(`Asset listed successfully on escrow contract.`);

      const listingId = `${assetTokenId}-${serialNumber}`;
      const listingData = {
        productName,
        price: price.toString(),
        description: description || "",
        location: location || "",
        sellerAccountId,
        serialNumber: serialNumber.toString(),
        tokenId: assetTokenId,
        state: 'LISTED',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      await db.collection('listings').doc(listingId).set(listingData);
      console.log(`Listing saved to Firestore with ID: ${listingId}`);

      await sendSms(sellerAccountId, `SUCCESS: Your product "${productName}" has been listed for ${price} HBAR. Listing ID: ${listingId}`);

      return response.status(200).send({ success: true, serialNumber, listingId });
    } catch (error) {
      console.error("FATAL ERROR in listProduct_ussd function:", error);
      const txId = error.transactionId || (sellerClient ? sellerClient.transactionId : null);
      return response.status(500).send({
        error: {
          message: error.message,
          details: `Transaction ID: ${txId}`.toString()
        }
      });
    }
  });
});

exports.mintRWA_ussd = onRequest({
  secrets: [hederaAdminAccountId, hederaAdminPrivateKey, hederaAdminSupplyKey]
}, (request, response) => {
  cors(request, response, async () => {
    console.log("mintRWA_ussd: Received request");
    console.log("Headers:", request.headers);
    console.log("Raw Body:", request.rawBody ? request.rawBody.toString('utf8').substring(0, 100) + '...' : 'N/A');
    if (request.method !== "POST") {
      return response.status(405).send({ error: { message: "Method Not Allowed" } });
    }
    try {
      console.log("Parsed Body:", request.body);
      const { accountId, assetType, quality, location } = request.body;
      if (!accountId || !assetType || !quality || !location) {
        return response.status(400).send({
          error: {
            message: "Missing required fields.",
            details: "Requires: accountId, assetType, quality, location."
          }
        });
      }

      const adminId = hederaAdminAccountId.value();
      const rawAdminPrivateKey = hederaAdminPrivateKey.value();
      const rawSupplyKey = hederaAdminSupplyKey.value();

      if (!rawAdminPrivateKey || !adminId || !rawSupplyKey) {
        console.error("FATAL: Admin credentials or supply key are not set.");
        throw new Error("Server configuration error: Admin credentials or supply key are not set.");
      }

      const adminPrivateKey = PrivateKey.fromStringECDSA(rawAdminPrivateKey);
      const supplyPrivateKey = PrivateKey.fromStringED25519(rawSupplyKey);
      const client = Client.forTestnet().setOperator(adminId, adminPrivateKey);

      const metadata = Buffer.from(JSON.stringify({ assetType, quality, location }));
      if (metadata.length > 100) {
        return response.status(400).send({ error: { message: "Metadata exceeds 100 bytes limit." } });
      }

      const mintTx = await new TokenMintTransaction()
        .setTokenId(assetTokenId)
        .setMetadata([metadata])
        .freezeWith(client);

      const signedMintTx = await mintTx.sign(supplyPrivateKey);
      const mintTxSubmit = await signedMintTx.execute(client);
      const mintRx = await mintTxSubmit.getReceipt(client);
      if (mintRx.status.toString() !== 'SUCCESS') {
        throw new Error(`Minting failed with status: ${mintRx.status.toString()}`);
      }

      if (!mintRx.serials || mintRx.serials.length === 0) {
        console.error("Minting receipt had no serial numbers.");
        throw new Error("Minting succeeded but no serial number was returned from the network.");
      }

      const serialNumber = Number(mintRx.serials[0]);
      console.log(`Successfully minted serial number: ${serialNumber}`);

      const transferTx = await new TransferTransaction()
        .addNftTransfer(assetTokenId, serialNumber, adminId, accountId)
        .freezeWith(client);

      const transferTxSubmit = await transferTx.execute(client);
      const transferRx = await transferTxSubmit.getReceipt(client);
      if (transferRx.status.toString() !== 'SUCCESS') {
        throw new Error(`NFT transfer to user failed with status: ${transferRx.status.toString()}`);
      }

      console.log(`SUCCESS: RWA minted and transferred to user ${accountId}. New Serial Number: ${serialNumber}.`);
      return response.status(200).send({
        tokenId: assetTokenId,
        serialNumber: serialNumber
      });

    } catch (error) {
      console.error("FATAL ERROR in mintRWA_ussd function:", error);
      let statusCode = 500;
      let message = error.message;
      if (message.includes("Invalid private key format")) statusCode = 400;
      if (message.includes("INVALID_SIGNATURE")) statusCode = 400;

      return response.status(statusCode).send({ error: { message, details: `Transaction ID: ${error.transactionId}` } });
    }
  });
});
