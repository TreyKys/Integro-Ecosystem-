const { onCall } = require("firebase-functions/v2/https");
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

exports.createAccount = onCall({ secrets: [hederaAdminAccountId, hederaAdminPrivateKey] }, async (request) => {
    try {
      const adminAccountId = hederaAdminAccountId.value();
      const rawAdminPrivateKey = hederaAdminPrivateKey.value();

      if (!adminAccountId || !rawAdminPrivateKey) {
        throw new functions.https.HttpsError('internal', 'Admin credentials are not set.');
      }

      const adminPrivateKey = PrivateKey.fromStringECDSA(rawAdminPrivateKey);
      const client = Client.forTestnet().setOperator(adminAccountId, adminPrivateKey);

      const newPriv = PrivateKey.generateECDSA();
      const newPrivHex0x = "0x" + newPriv.toStringRaw();
      const newPubKey = newPriv.publicKey;

      const acctTx = new AccountCreateTransaction()
        .setKey(newPubKey)
        .setInitialBalance(new Hbar(65));

      const acctSubmit = await acctTx.execute(client);
      const acctReceipt = await acctSubmit.getReceipt(client);
      const newAccountId = acctReceipt.accountId;
      if (!newAccountId) {
        throw new functions.https.HttpsError('internal', 'Failed to create account.');
      }

      const evmAddress = (new ethers.Wallet(newPrivHex0x)).address;

      return {
        accountId: newAccountId.toString(),
        privateKey: newPrivHex0x,
        evmAddress: evmAddress
      };

    } catch (error) {
      console.error("FATAL ERROR in createAccount function:", error);
      throw new functions.https.HttpsError('internal', error.message, error);
    }
});

exports.executeNativeNftTransfer = onCall({ secrets: [hederaAdminAccountId, hederaAdminPrivateKey] }, async (request) => {
    try {
      const { sellerAccountId, buyerAccountId, serialNumber } = request.data;
      if (!sellerAccountId || !buyerAccountId || !serialNumber) {
        throw new functions.https.HttpsError('invalid-argument', 'Missing required fields.');
      }

      const adminId = hederaAdminAccountId.value();
      const rawAdminPrivateKey = hederaAdminPrivateKey.value();

      if (!rawAdminPrivateKey || !adminId) {
        throw new functions.https.HttpsError('internal', 'Admin credentials are not set.');
      }

      const adminPrivateKey = PrivateKey.fromStringECDSA(rawAdminPrivateKey);
      const client = Client.forTestnet().setOperator(adminId, adminPrivateKey);

      const transferTx = await new TransferTransaction()
        .addNftTransfer(assetTokenContractId, serialNumber, sellerAccountId, buyerAccountId)
        .freezeWith(client);

      const transferTxSubmit = await transferTx.execute(client);
      const transferRx = await transferTxSubmit.getReceipt(client);

      if (transferRx.status.toString() !== 'SUCCESS') {
        throw new functions.https.HttpsError('internal', `NFT transfer failed with status: ${transferRx.status.toString()}`);
      }

      return {
        success: true,
        transactionId: transferTxSubmit.transactionId.toString()
      };

    } catch (error) {
      console.error("ERROR in executeNativeNftTransfer:", error);
      throw new functions.https.HttpsError('internal', error.message, error);
    }
});

exports.mintRWAviaUSSD = onCall({
  secrets: [hederaAdminAccountId, hederaAdminPrivateKey, hederaAdminSupplyKey]
}, async (request) => {
    try {
      const { accountId, assetType, quality, location } = request.data;
      if (!accountId || !assetType || !quality || !location) {
        throw new functions.https.HttpsError('invalid-argument', 'Missing required fields.');
      }

      const adminId = hederaAdminAccountId.value();
      const rawAdminPrivateKey = hederaAdminPrivateKey.value();
      const rawSupplyKey = hederaAdminSupplyKey.value();

      if (!rawAdminPrivateKey || !adminId || !rawSupplyKey) {
        throw new functions.https.HttpsError('internal', 'Admin credentials are not set.');
      }

      const adminPrivateKey = PrivateKey.fromStringECDSA(rawAdminPrivateKey);
      const supplyPrivateKey = PrivateKey.fromStringED25519(rawSupplyKey);
      const client = Client.forTestnet().setOperator(adminId, adminPrivateKey);

      const metadata = Buffer.from(JSON.stringify({ assetType, quality, location }));
      if (metadata.length > 100) {
        throw new functions.https.HttpsError('invalid-argument', 'Metadata exceeds 100 bytes limit.');
      }

      const mintTx = await new TokenMintTransaction()
        .setTokenId(assetTokenContractId)
        .setMetadata([metadata])
        .freezeWith(client);

      const signedMintTx = await mintTx.sign(supplyPrivateKey);
      const mintTxSubmit = await signedMintTx.execute(client);
      const mintRx = await mintTxSubmit.getReceipt(client);

      if (!mintRx.serials || mintRx.serials.length === 0) {
        throw new functions.https.HttpsError('internal', 'Minting succeeded but no serial number was returned.');
      }

      const serialNumber = Number(mintRx.serials[0].toString());

      const transferTx = await new TransferTransaction()
        .addNftTransfer(assetTokenContractId, serialNumber, adminId, accountId)
        .freezeWith(client)
        .execute(client);

      const transferRx = await transferTx.getReceipt(client);

      if (transferRx.status.toString() !== 'SUCCESS') {
        throw new functions.https.HttpsError('internal', `NFT transfer failed with status: ${transferRx.status.toString()}`);
      }

      return {
        tokenId: assetTokenContractId,
        serialNumber: serialNumber
      };

    } catch (error) {
        console.error("ERROR minting RWA via USSD:", error);
        throw new functions.https.HttpsError('internal', error.message, error);
    }
});

exports.setUserProfile = onCall(async (request) => {
    try {
      const { accountId, displayName, role, location } = request.data;
      if (!accountId || !displayName || !role || !location) {
        throw new functions.https.HttpsError('invalid-argument', 'Missing required profile fields.');
      }

      const db = admin.firestore();
      const profileRef = db.collection("profiles").doc(accountId);

      await profileRef.set({
        displayName,
        role,
        location,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return { success: true, message: "Profile saved." };

    } catch (error) {
      console.error("ERROR in setUserProfile function:", error);
      throw new functions.https.HttpsError('internal', error.message, error);
    }
});
