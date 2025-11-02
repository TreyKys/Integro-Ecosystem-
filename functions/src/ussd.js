const { https } = require("firebase-functions");
const fetch = require('node-fetch');
const { Hbar, Client, PrivateKey, TokenMintTransaction, TransferTransaction, TokenAssociateTransaction, AccountAllowanceApproveTransaction, ContractExecuteTransaction, ContractFunctionParameters } = require("@hashgraph/sdk");
const admin = require("firebase-admin");
const { logger } = require("firebase-functions");


// --- Secrets ---
const HEDERA_ADMIN_ACCOUNT_ID = process.env.HEDERA_ADMIN_ACCOUNT_ID;
const HEDERA_ADMIN_PRIVATE_KEY = process.env.HEDERA_ADMIN_PRIVATE_KEY;
const HEDERA_ADMIN_SUPPLY_KEY = process.env.HEDERA_ADMIN_SUPPLY_KEY;

// --- Configuration ---
const assetTokenId = "0.0.7134449"; // Replace with your token ID
const escrowContractId = "0.0.7152729"; // Replace with your contract ID
const CREATE_ACCOUNT_URL = "https://createaccount-cehqwvb4aq-uc.a.run.app";


// ---
// This is your NEW, safe wrapper function
// ---
exports.createAccountFromUSSD = https.onCall(async (data, context) => {

    // 1. Get the SIMPLE data from the USSD simulator
    const { name, pin } = data;

    // 2. TRANSFORM it into the object your ORIGINAL `createAccount` expects
    const requestBody = {
        fullName: name, // Match the expected field
        pin: pin,
        email: 'user@ussd.integro.io', // Placeholder email
    };

    try {
        // 3. Call your ORIGINAL, WORKING `createAccount` function via HTTP
        const response = await fetch(CREATE_ACCOUNT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error("Internal call to createAccount failed:", errorText);
            throw new https.HttpsError('internal', `The account creation failed with status: ${response.status}`);
        }

        const responseData = await response.json();

        // 4. Return the successful result to the USSD simulator
        return responseData;

    } catch (error) {
        // 5. If the original function fails, pass the error back
        console.error("Internal call to createAccount failed:", error);
        throw new https.HttpsError('internal', 'The account creation failed.');
    }
});

exports.listProductFromUSSD = https.onCall(async (data, context) => {
    try {
        const { sellerAccountId, productName, price, description, location } = data;
        if (!sellerAccountId || !productName || !price || !description || !location) {
            throw new https.HttpsError('invalid-argument', 'Missing required arguments.');
        }

        const db = admin.firestore();
        const userDoc = await db.collection("users").doc(sellerAccountId).get();
        if (!userDoc.exists) {
            throw new https.HttpsError('not-found', 'User not found.');
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
        logger.error("Error in listProductFromUSSD:", error);
        throw new https.HttpsError('internal', 'An unexpected error occurred.', error.message);
    }
});

exports.fundEscrowFromUSSD = https.onCall(async (data, context) => {
    try {
        const { buyerAccountId, listingId } = data;
        if (!buyerAccountId || !listingId) {
            throw new https.HttpsError('invalid-argument', 'Missing required arguments.');
        }

        const db = admin.firestore();
        const userDoc = await db.collection("users").doc(buyerAccountId).get();
        if (!userDoc.exists) {
            throw new https.HttpsError('not-found', 'User not found.');
        }
        const buyerPrivateKey = userDoc.data().privateKey;


        const listingDoc = await db.collection("listings").doc(listingId).get();
        if (!listingDoc.exists) {
            throw new https.HttpsError('not-found', 'Listing not found.');
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
        logger.error("Error in fundEscrowFromUSSD:", error);
        throw new https.HttpsError('internal', 'An unexpected error occurred.', error.message);
    }
});

exports.confirmDeliveryFromUSSD = https.onCall(async (data, context) => {
    try {
        const { buyerAccountId, listingId } = data;
        if (!buyerAccountId || !listingId) {
            throw new https.HttpsError('invalid-argument', 'Missing required arguments.');
        }

        const db = admin.firestore();
        const userDoc = await db.collection("users").doc(buyerAccountId).get();
        if (!userDoc.exists) {
            throw new https.HttpsError('not-found', 'User not found.');
        }
        const buyerPrivateKey = userDoc.data().privateKey;


        const listingDoc = await db.collection("listings").doc(listingId).get();
        if (!listingDoc.exists) {
            throw new https.HttpsError('not-found', 'Listing not found.');
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
        logger.error("Error in confirmDeliveryFromUSSD:", error);
        throw new https.HttpsError('internal', 'An unexpected error occurred.', error.message);
    }
});
