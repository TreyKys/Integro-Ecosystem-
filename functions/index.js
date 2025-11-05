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
  TransferTransaction
} = require("@hashgraph/sdk");
const cors = require("cors")({ origin: true });
const ethers = require("ethers");

// Initialize Firebase Admin SDK
admin.initializeApp();

// Define secrets
const hederaAdminAccountId = defineSecret('HEDERA_ADMIN_ACCOUNT_ID');
const hederaAdminPrivateKey = defineSecret('HEDERA_ADMIN_PRIVATE_KEY');
const hederaAdminSupplyKey =
  defineSecret('HEDERA_ADMIN_SUPPLY_KEY');

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
