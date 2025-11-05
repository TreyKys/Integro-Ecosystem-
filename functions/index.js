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
      const { sellerAccountId, buyerAccountId, serialNumber } = request.body;
      if (!sellerAccountId || !buyerAccountId || !serialNumber) {
        throw new Error("Missing required fields: sellerAccountId, buyerAccountId, serialNumber.");
      }

      const adminId = hederaAdminAccountId.value();
      const rawAdminPrivateKey = hederaAdminPrivateKey.value();

      if (!rawAdminPrivateKey || !adminId) {
        throw new Error("Admin credentials are not set as secrets.");
      }

      const adminPrivateKey = PrivateKey.fromStringECDSA(rawAdminPrivateKey);
      const client = Client.forTestnet().setOperator(adminId, adminPrivateKey);

      // The assetTokenId is defined globally, but let's ensure it's explicitly available.
      const assetTokenId = "0.0.7134449";
      const transferTx = await new TransferTransaction()
        .addNftTransfer(assetTokenId, serialNumber, sellerAccountId, buyerAccountId)
        .freezeWith(client);

      // No need to sign with adminPrivateKey again, client operator already handles it.
      const transferTxSubmit = await transferTx.execute(client);
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
      return response.status(500).send({ error: error.message });
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
