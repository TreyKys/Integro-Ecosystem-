const functions = require("firebase-functions");
const {
    Hbar,
    Client,
    PrivateKey,
    AccountCreateTransaction,
    PublicKey,
    TokenMintTransaction,
    TransferTransaction,
    TokenAssociateTransaction,
    AccountAllowanceApproveTransaction,
    ContractExecuteTransaction,
    ContractFunctionParameters
} = require("@hashgraph/sdk");
const { logger } = require("firebase-functions");
const ethers = require("ethers");
const admin = require("firebase-admin");

// --- Secrets ---
// For onCall functions, secrets are accessed via process.env
const HEDERA_ADMIN_ACCOUNT_ID = process.env.HEDERA_ADMIN_ACCOUNT_ID;
const HEDERA_ADMIN_PRIVATE_KEY = process.env.HEDERA_ADMIN_PRIVATE_KEY;
const HEDERA_ADMIN_SUPPLY_KEY = process.env.HEDERA_ADMIN_SUPPLY_KEY;


// --- Configuration ---
const assetTokenId = "0.0.7134449"; // Replace with your token ID
const escrowContractId = "0.0.7152729"; // Replace with your contract ID


// Initialize Firebase Admin if not already done
if (admin.apps.length === 0) {
  admin.initializeApp();
}

exports.createAccountUSSD = functions
  .runWith({ secrets: ["HEDERA_ADMIN_ACCOUNT_ID", "HEDERA_ADMIN_PRIVATE_KEY"] })
  .https.onCall(async (data, context) => {
    console.log("--- createAccountUSSD ---");
    try {
      const { name, pin } = data;
      if (!name || !pin) {
        throw new functions.https.HttpsError('invalid-argument', 'The function must be called with "name" and "pin" arguments.');
      }

      console.log("Secrets loaded:", {
        adminAccountId: HEDERA_ADMIN_ACCOUNT_ID ? 'Loaded' : 'MISSING',
        adminPrivateKey: HEDERA_ADMIN_PRIVATE_KEY ? 'Loaded' : 'MISSING'
      });


      const adminAccountId = HEDERA_ADMIN_ACCOUNT_ID;
      const rawAdminPrivateKey = HEDERA_ADMIN_PRIVATE_KEY;

      if (!adminAccountId || !rawAdminPrivateKey) {
        console.error("Admin credentials missing in environment.");
        throw new functions.https.HttpsError('failed-precondition', 'Admin credentials are not set.');
      }

      const client = Client.forTestnet();
      client.setOperator(adminAccountId, PrivateKey.fromStringECDSA(rawAdminPrivateKey));

      const newPrivKey = PrivateKey.generateECDSA();
      const newPubKey = newPrivKey.publicKey;
      const newPrivKeyHex0x = "0x" + newPrivKey.toStringRaw();

      console.log("Attempting to execute AccountCreateTransaction...");
      const acctTx = await new AccountCreateTransaction()
        .setKey(newPubKey)
        .setInitialBalance(new Hbar(65))
        .execute(client);

      const acctReceipt = await acctTx.getReceipt(client);
      const newAccountId = acctReceipt.accountId;
      console.log("Account created successfully:", newAccountId.toString());


      if (!newAccountId) {
        throw new functions.https.HttpsError('internal', 'Account creation failed to return an ID.');
      }

      const evmAddress = (new ethers.Wallet(newPrivKeyHex0x)).address;

      // Store user data in Firestore
      const db = admin.firestore();
      await db.collection("users").doc(newAccountId.toString()).set({
        name,
        pin, // Note: Storing PIN in plaintext is not secure for production.
        accountId: newAccountId.toString(),
        evmAddress: evmAddress,
        privateKey: newPrivKeyHex0x, // Storing the private key securely in Firestore
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log("User data stored in Firestore.");

      return {
        accountId: newAccountId.toString(),
        evmAddress: evmAddress
      };

    } catch (error) {
        logger.error("Error in createAccountUSSD:", error);
        if (error instanceof functions.https.HttpsError) {
            throw error;
        }
        throw new functions.https.HttpsError('internal', 'An unexpected error occurred.', error.message);
    }
});

exports.listProductUSSD = functions
    .runWith({ secrets: ["HEDERA_ADMIN_ACCOUNT_ID", "HEDERA_ADMIN_PRIVATE_KEY", "HEDERA_ADMIN_SUPPLY_KEY"] })
    .https.onCall(async (data, context) => {
        try {
            const { sellerAccountId, productName, price, description, location } = data;
            if (!sellerAccountId || !productName || !price || !description || !location) {
                throw new functions.https.HttpsError('invalid-argument', 'Missing required arguments.');
            }

            const db = admin.firestore();
            const userDoc = await db.collection("users").doc(sellerAccountId).get();
            if (!userDoc.exists) {
                throw new functions.https.HttpsError('not-found', 'User not found.');
            }
            const sellerPrivateKey = userDoc.data().privateKey;


            // 1. Setup Clients
            const adminId = HEDERA_ADMIN_ACCOUNT_ID;
            const adminKey = PrivateKey.fromStringECDSA(HEDERA_ADMIN_PRIVATE_KEY);
            const supplyKey = PrivateKey.fromStringECDSA(HEDERA_ADMIN_SUPPLY_KEY);

            const adminClient = Client.forTestnet().setOperator(adminId, adminKey);
            const sellerClient = Client.forTestnet().setOperator(sellerAccountId, PrivateKey.fromStringECDSA(sellerPrivateKey));

            // 2. Mint NFT (as admin)
            const mintTx = await new TokenMintTransaction()
                .setTokenId(assetTokenId)
                .setMetadata([Buffer.from(description)])
                .freezeWith(adminClient);
            const signedMintTx = await mintTx.sign(supplyKey);
            const mintSubmit = await signedMintTx.execute(adminClient);
            const mintRx = await mintSubmit.getReceipt(adminClient);
            const serialNumber = mintRx.serials[0].low;

            // 3. Associate Token with seller
            const associateTx = await new TokenAssociateTransaction()
                .setAccountId(sellerAccountId)
                .setTokenIds([assetTokenId])
                .execute(sellerClient);
            await associateTx.getReceipt(sellerClient);

            // 4. Transfer NFT to Seller
            const transferTx = await new TransferTransaction()
                .addNftTransfer(assetTokenId, serialNumber, adminId, sellerAccountId)
                .execute(adminClient);
            await transferTx.getReceipt(adminClient);

            // 5. Approve Escrow Contract
            const approveTx = await new AccountAllowanceApproveTransaction()
                .approveTokenNftAllowance(assetTokenId, sellerAccountId, escrowContractId, [serialNumber])
                .execute(sellerClient);
            await approveTx.getReceipt(sellerClient);

            // 6. List on Escrow
            const listTx = await new ContractExecuteTransaction()
                .setContractId(escrowContractId)
                .setGas(1000000)
                .setFunction("listAsset", new ContractFunctionParameters().addUint256(serialNumber).addUint256(Hbar.from(price).toTinybars()))
                .execute(sellerClient);
            await listTx.getReceipt(sellerClient);

            // 7. Save to Firestore
            const listingId = `${assetTokenId}-${serialNumber}`;
            await db.collection("listings").doc(listingId).set({
                productName,
                price,
                description,
                location,
                sellerAccountId,
                serialNumber,
                tokenId: assetTokenId,
                state: 'LISTED',
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });

            return { success: true, serialNumber, listingId };

        } catch (error) {
            logger.error("Error in listProductUSSD:", error);
            throw new functions.https.HttpsError('internal', 'An unexpected error occurred.', error.message);
        }
    });

exports.fundEscrowUSSD = functions.https.onCall(async (data, context) => {
    try {
        const { buyerAccountId, listingId } = data;
        if (!buyerAccountId || !listingId) {
            throw new functions.https.HttpsError('invalid-argument', 'Missing required arguments.');
        }

        const db = admin.firestore();
        const userDoc = await db.collection("users").doc(buyerAccountId).get();
        if (!userDoc.exists) {
            throw new functions.https.HttpsError('not-found', 'User not found.');
        }
        const buyerPrivateKey = userDoc.data().privateKey;


        const listingDoc = await db.collection("listings").doc(listingId).get();
        if (!listingDoc.exists) {
            throw new functions.https.HttpsError('not-found', 'Listing not found.');
        }
        const listing = listingDoc.data();
        const price = listing.price;

        const client = Client.forTestnet().setOperator(buyerAccountId, PrivateKey.fromStringECDSA(buyerPrivateKey));

        const fundTx = await new ContractExecuteTransaction()
            .setContractId(escrowContractId)
            .setGas(1000000)
            .setPayableAmount(new Hbar(price))
            .setFunction("fundEscrow", new ContractFunctionParameters().addUint256(listing.serialNumber))
            .execute(client);

        await fundTx.getReceipt(client);

        await db.collection("listings").doc(listingId).update({
            state: 'FUNDED',
            buyerAccountId: buyerAccountId
        });

        return { success: true };
    } catch (error) {
        logger.error("Error in fundEscrowUSSD:", error);
        throw new functions.https.HttpsError('internal', 'An unexpected error occurred.', error.message);
    }
});

exports.confirmDeliveryUSSD = functions.https.onCall(async (data, context) => {
    try {
        const { buyerAccountId, listingId } = data;
        if (!buyerAccountId || !listingId) {
            throw new functions.https.HttpsError('invalid-argument', 'Missing required arguments.');
        }

        const db = admin.firestore();
        const userDoc = await db.collection("users").doc(buyerAccountId).get();
        if (!userDoc.exists) {
            throw new functions.https.HttpsError('not-found', 'User not found.');
        }
        const buyerPrivateKey = userDoc.data().privateKey;


        const listingDoc = await db.collection("listings").doc(listingId).get();
        if (!listingDoc.exists) {
            throw new functions.https.HttpsError('not-found', 'Listing not found.');
        }
        const listing = listingDoc.data();

        const client = Client.forTestnet().setOperator(buyerAccountId, PrivateKey.fromStringECDSA(buyerPrivateKey));

        const confirmTx = await new ContractExecuteTransaction()
            .setContractId(escrowContractId)
            .setGas(1000000)
            .setFunction("confirmDelivery", new ContractFunctionParameters().addUint256(listing.serialNumber))
            .execute(client);

        await confirmTx.getReceipt(client);

        await db.collection("listings").doc(listingId).update({
            state: 'DELIVERED',
        });

        return { success: true };
    } catch (error) {
        logger.error("Error in confirmDeliveryUSSD:", error);
        throw new functions.https.HttpsError('internal', 'An unexpected error occurred.', error.message);
    }
});
