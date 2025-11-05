const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
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

async function _mintAndTransferNFT(adminId, rawAdminPrivateKey, rawSupplyKey, userAccountId, metadata) {
  if (!rawAdminPrivateKey || !adminId || !rawSupplyKey) {
    throw new Error("Admin credentials or supply key are not set as secrets.");
  }
  if (metadata.length > 100) {
    throw new Error("Metadata exceeds 100 bytes limit.");
  }

  const adminPrivateKey = PrivateKey.fromStringECDSA(rawAdminPrivateKey);
  const supplyPrivateKey = PrivateKey.fromStringED25519(rawSupplyKey);
  const client = Client.forTestnet().setOperator(adminId, adminPrivateKey);

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
    .addNftTransfer(assetTokenContractId, serialNumber, adminId, userAccountId)
    .freezeWith(client)
    .execute(client);

  const transferRx = await transferTx.getReceipt(client);

  if (transferRx.status.toString() !== 'SUCCESS') {
    throw new Error(`NFT transfer to user failed with status: ${transferRx.status.toString()}`);
  }

  console.log(`SUCCESS: RWA minted and transferred to user ${userAccountId}. New Serial Number: ${serialNumber}.`);
  return {
    tokenId: assetTokenContractId,
    serialNumber: serialNumber
  };
}

// --- Reusable Core Logic ---

async function _createHederaAccount(adminAccountId, rawAdminPrivateKey) {
  if (!adminAccountId || !rawAdminPrivateKey) {
    throw new Error("Admin credentials are not provided.");
  }

  const adminPrivateKey = PrivateKey.fromStringECDSA(rawAdminPrivateKey);
  const client = Client.forTestnet().setOperator(adminAccountId, adminPrivateKey);

  const newPriv = PrivateKey.generateECDSA();
  const newPrivHex0x = "0x" + newPriv.toStringRaw();
  const newPubKey = newPriv.publicKey;

  console.log("_createHederaAccount: generated ECDSA privateKey (hex):", newPrivHex0x);

  const acctTx = new AccountCreateTransaction()
    .setKey(newPubKey)
    .setInitialBalance(new Hbar(65));

  const acctSubmit = await acctTx.execute(client);
  const acctReceipt = await acctSubmit.getReceipt(client);
  const newAccountId = acctReceipt.accountId;

  if (!newAccountId) {
    throw new Error("Failed to create account; no account id returned.");
  }
  console.log("_createHederaAccount: created accountId:", newAccountId.toString());

  const evmAddress = (new ethers.Wallet(newPrivHex0x)).address;
  console.log("_createHederaAccount: derived evmAddress (from ECDSA key):", evmAddress);

  return {
    accountId: newAccountId.toString(),
    privateKey: newPrivHex0x,
    evmAddress: evmAddress
  };
}


exports.createAccount = onRequest({ secrets: [hederaAdminAccountId, hederaAdminPrivateKey] }, (request, response) => {
  cors(request, response, async () => {
    if (request.method !== "POST") {
      return response.status(405).send("Method Not Allowed");
    }
    try {
      const adminAccountId = hederaAdminAccountId.value();
      const rawAdminPrivateKey = hederaAdminPrivateKey.value();

      const newAccount = await _createHederaAccount(adminAccountId, rawAdminPrivateKey);

      return response.status(200).send(newAccount);

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

      const metadata = Buffer.from(JSON.stringify({ assetType, quality, location }));
      const result = await _mintAndTransferNFT(adminId, rawAdminPrivateKey, rawSupplyKey, accountId, metadata);

      return response.status(200).send(result);

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

// --- USSD Gateway ---
exports.ussdGateway = onCall({ secrets: [hederaAdminAccountId, hederaAdminPrivateKey, hederaAdminSupplyKey] }, async (request) => {
  const { accountId, text } = request.data;
  // NOTE: accountId can be null for the very first interaction (Create Account)

  const db = admin.firestore();
  const sessionsRef = db.collection("ussd_sessions");

  let sessionData = {};
  if (accountId) {
    const sessionDoc = await sessionsRef.doc(accountId).get();
    if (sessionDoc.exists) {
      sessionData = sessionDoc.data();
    }
  }

  // If no session, default to the main menu
  const currentMenu = sessionData.currentMenu || 'MAIN';

  let responseText = '';

  // --- Main Menu ---
  if (currentMenu === 'MAIN') {
    if (text === '*878#') {
      responseText = `CON Welcome to Integro USSD\n1. Create Account\n2. Marketplace\n3. Mint & List Item\n4. My Assets & Gigs`;
      if(accountId) await sessionsRef.doc(accountId).set({ currentMenu: 'MAIN', page: 0 });

    } else if (text === '1') {
        // --- Create Account Flow ---
        try {
            const adminAccountId = hederaAdminAccountId.value();
            const rawAdminPrivateKey = hederaAdminPrivateKey.value();
            const newAccount = await _createHederaAccount(adminAccountId, rawAdminPrivateKey);

            // Securely store the private key
            const vaultsRef = db.collection("user_vaults").doc(newAccount.accountId);
            await vaultsRef.set({ privateKey: newAccount.privateKey });

            // Set the user's session
            await sessionsRef.doc(newAccount.accountId).set({ currentMenu: 'MAIN', page: 0 });

            responseText = `END Congratulations! Your new account ID is:\n${newAccount.accountId}\n\nPlease save this ID. Dial *878# again to use the marketplace.`;

        } catch (error) {
            console.error("ERROR in USSD Account Creation:", error);
            responseText = `END We're sorry, there was a problem creating your account. Please try again later.`;
        }
    } else if (text === '2') {
        // --- View Marketplace Flow ---
        const listingsQuery = db.collection("listings").where("state", "==", "LISTED").orderBy("createdAt", "desc").limit(5);
        const listings = await listingsQuery.get();

        if (listings.empty) {
            responseText = `END The marketplace is currently empty. Check back later!`;
        } else {
            let menuText = "CON Marketplace Listings:\n";
            const listingsData = [];
            listings.forEach((doc, index) => {
                const data = doc.data();
                const priceInHbar = data.priceTinybars / 100_000_000;
                menuText += `${index + 1}. ${data.name} (${priceInHbar} HBAR)\n`;
                listingsData.push({ id: doc.id, ...data });
            });
            menuText += `99. Next Page`;
            responseText = menuText;

            const lastVisible = listings.docs[listings.docs.length - 1].id;
            await sessionsRef.doc(accountId).set({ currentMenu: 'MARKETPLACE', page: 0, listings: listingsData, lastVisible });
        }
    } else if (text === '3') {
        // --- Mint & List Flow ---
        await sessionsRef.doc(accountId).set({ currentMenu: 'MINT_LIST', mintStep: 'GET_NAME' });
        responseText = `CON What is the name of the item you are listing?`;
    } else if (text === '4') {
        // --- View My Assets Flow ---
        const assetsQuery = db.collection("listings").where("buyerAccountId", "==", accountId).orderBy("createdAt", "desc").limit(5);
        const assets = await assetsQuery.get();
        if (assets.empty) {
            responseText = `END You do not own any assets yet.`;
        } else {
            let menuText = "CON Your Assets:\n";
            const assetsData = [];
            assets.forEach((doc, index) => {
                const data = doc.data();
                let actionText = `(Status: ${data.state})`;
                if (data.state === 'FUNDED') {
                    actionText = `[${index + 1}. Confirm Delivery]`;
                }
                menuText += `${index + 1}. ${data.name} ${actionText}\n`;
                assetsData.push({ id: doc.id, ...data });
            });
            menuText += `99. Next Page`;
            responseText = menuText;

            const lastVisible = assets.docs[assets.docs.length - 1].id;
            await sessionsRef.doc(accountId).set({ currentMenu: 'MY_ASSETS', page: 0, assets: assetsData, lastVisible });
        }
    } else {
       responseText = `CON Invalid input. Please dial *878# to begin.`;
    }
  }

  // --- Mint & List Menu ---
  else if (currentMenu === 'MINT_LIST') {
    const mintStep = sessionData.mintStep || 'GET_NAME';

    if (mintStep === 'GET_NAME') {
        await sessionsRef.doc(accountId).set({ ...sessionData, mintStep: 'GET_PRICE', itemName: text });
        responseText = `CON Enter the price of "${text}" in HBAR:`;

    } else if (mintStep === 'GET_PRICE') {
        const itemName = sessionData.itemName;
        const priceHbar = parseFloat(text);
        if (isNaN(priceHbar) || priceHbar <= 0) {
            responseText = `CON Invalid price. Please enter a positive number for the price in HBAR:`;
        } else {
            await sessionsRef.doc(accountId).set({ ...sessionData, mintStep: 'CONFIRM', priceHbar: priceHbar });
            responseText = `CON List "${itemName}" for ${priceHbar} HBAR?\n1. Confirm\n2. Cancel`;
        }
    } else if (mintStep === 'CONFIRM') {
      if (text === '1') {
        try {
            const { itemName, priceHbar } = sessionData;
            const adminId = hederaAdminAccountId.value();
            const rawAdminPrivateKey = hederaAdminPrivateKey.value();
            const rawSupplyKey = hederaAdminSupplyKey.value();

            // 1. Mint the NFT
            const metadata = Buffer.from(JSON.stringify({ name: itemName, type: "RWA" }));
            const mintResult = await _mintAndTransferNFT(adminId, rawAdminPrivateKey, rawSupplyKey, accountId, metadata);

            // 2. Create the listing in Firestore
            const priceTinybars = Math.floor(priceHbar * 100_000_000);
            await db.collection("listings").add({
                name: itemName,
                priceTinybars: priceTinybars,
                sellerAccountId: accountId,
                buyerAccountId: null,
                state: 'LISTED',
                serialNumber: mintResult.serialNumber,
                tokenId: mintResult.tokenId,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            responseText = `END Your item "${itemName}" has been successfully listed!`;
            await sessionsRef.doc(accountId).set({ currentMenu: 'MAIN', page: 0 }); // Reset session
        } catch (error) {
            console.error("ERROR during USSD mint/list:", error);
            responseText = "END An error occurred. Please try again.";
            await sessionsRef.doc(accountId).set({ currentMenu: 'MAIN', page: 0 });
        }
      } else {
        responseText = `END Listing cancelled.`;
        await sessionsRef.doc(accountId).set({ currentMenu: 'MAIN', page: 0 });
      }
    }
  }

  // --- Marketplace Menu ---
  else if (currentMenu === 'MY_ASSETS') {
    const displayedAssets = sessionData.assets || [];
    const selection = parseInt(text, 10);

    if (selection >= 1 && selection <= displayedAssets.length) {
        const selectedAsset = displayedAssets[selection - 1];
        if (selectedAsset.state === 'FUNDED') {
            await sessionsRef.doc(accountId).set({
                currentMenu: 'DELIVERY_CONFIRM',
                listingId: selectedAsset.id,
                listingName: selectedAsset.name
            });
            responseText = `CON Confirm delivery for "${selectedAsset.name}"?\n1. Confirm\n2. Cancel`;
        } else {
            responseText = `CON No action available for "${selectedAsset.name}" (Status: ${selectedAsset.state}).`;
        }
    } else {
        responseText = `CON Invalid selection.`;
    }
  }
  else if (currentMenu === 'DELIVERY_CONFIRM') {
      const { listingId, listingName } = sessionData;
      if (text === '1') {
          try {
            const vaultDoc = await db.collection("user_vaults").doc(accountId).get();
            if (!vaultDoc.exists) throw new HttpsError("not-found", "User credentials not found.");
            const { privateKey } = vaultDoc.data();

            const provider = new ethers.JsonRpcProvider("https://testnet.hashio.io/api");
            const signer = new ethers.Wallet(privateKey, provider);

            const escrowAddress = "0xF041085D692101EcFBCd7C57e712Ab716Ee20081";
            const escrowAbi = [{"inputs":[{"internalType":"address","name":"_assetTokenAddress","type":"address"}],"stateMutability":"nonpayable","type":"constructor"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"tokenId","type":"uint256"},{"indexed":true,"internalType":"address","name":"seller","type":"address"},{"indexed":false,"internalType":"uint256","name":"price","type":"uint256"}],"name":"AssetListed","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"tokenId","type":"uint256"},{"indexed":true,"internalType":"address","name":"buyer","type":"address"}],"name":"EscrowFunded","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"tokenId","type":"uint256"}],"name":"ListingCanceled","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"tokenId","type":"uint256"},{"indexed":true,"internalType":"address","name":"seller","type":"address"},{"indexed":true,"internalType":"address","name":"buyer","type":"address"}],"name":"SaleCompleted","type":"event"},{"inputs":[],"name":"assetTokenAddress","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"tokenId","type":"uint256"}],"name":"cancelListing","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"tokenId","type":"uint256"}],"name":"confirmDelivery","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"tokenId","type":"uint256"}],"name":"fundEscrow","outputs":[],"stateMutability":"payable","type":"function"},{"inputs":[{"internalType":"uint256","name":"tokenId","type":"uint256"}],"name":"getListingPrice","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"tokenId","type":"uint256"},{"internalType":"uint256","name":"priceInWei","type":"uint256"}],"name":"listAsset","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"","type":"uint256"}],"name":"listings","outputs":[{"internalType":"address","name":"seller","type":"address"},{"internalType":"address","name":"buyer","type":"address"},{"internalType":"uint256","name":"price","type":"uint256"},{"internalType":"enum Escrow.ListingState","name":"state","type":"uint8"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"tokenId","type":"uint256"}],"name":"refundBuyer","outputs":[],"stateMutability":"nonpayable","type":"function"}];
            const escrowContract = new ethers.Contract(escrowAddress, escrowAbi, signer);

            const listingDoc = await db.collection("listings").doc(listingId).get();
            if (!listingDoc.exists) throw new HttpsError("not-found", "Listing not found.");
            const listingData = listingDoc.data();

            const tx = await escrowContract.confirmDelivery(listingData.serialNumber, { gasLimit: 1_000_000 });
            await tx.wait();

            await db.collection("listings").doc(listingId).update({ state: "SOLD" });

            responseText = `END Delivery confirmed for "${listingName}". The seller has been paid.`;
            await sessionsRef.doc(accountId).set({ currentMenu: 'MAIN', page: 0 });

          } catch (error) {
              console.error("ERROR during USSD confirmDelivery:", error);
              responseText = "END Transaction failed. Please try again.";
              await sessionsRef.doc(accountId).set({ currentMenu: 'MAIN', page: 0 });
          }
      } else {
          responseText = `END Delivery confirmation for "${listingName}" cancelled.`;
          await sessionsRef.doc(accountId).set({ currentMenu: 'MAIN', page: 0 });
      }
  }
  else if (currentMenu === 'BUY_CONFIRM') {
    const { listingId, listingName, priceHbar } = sessionData;
    if (text === '1') { // User confirms purchase
        try {
            // 1. Retrieve the buyer's private key
            const vaultDoc = await db.collection("user_vaults").doc(accountId).get();
            if (!vaultDoc.exists) {
                throw new HttpsError("not-found", "User credentials not found.");
            }
            const { privateKey } = vaultDoc.data();

            // 2. Set up the provider and signer
            const provider = new ethers.JsonRpcProvider("https://testnet.hashio.io/api");
            const signer = new ethers.Wallet(privateKey, provider);

            // 3. Prepare and send the transaction
            const escrowAddress = "0xF041085D692101EcFBCd7C57e712Ab716Ee20081"; // The address from deployment
            const escrowAbi = [{"inputs":[{"internalType":"address","name":"_assetTokenAddress","type":"address"}],"stateMutability":"nonpayable","type":"constructor"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"tokenId","type":"uint256"},{"indexed":true,"internalType":"address","name":"seller","type":"address"},{"indexed":false,"internalType":"uint256","name":"price","type":"uint256"}],"name":"AssetListed","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"tokenId","type":"uint256"},{"indexed":true,"internalType":"address","name":"buyer","type":"address"}],"name":"EscrowFunded","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"tokenId","type":"uint256"}],"name":"ListingCanceled","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"tokenId","type":"uint256"},{"indexed":true,"internalType":"address","name":"seller","type":"address"},{"indexed":true,"internalType":"address","name":"buyer","type":"address"}],"name":"SaleCompleted","type":"event"},{"inputs":[],"name":"assetTokenAddress","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"tokenId","type":"uint256"}],"name":"cancelListing","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"tokenId","type":"uint256"}],"name":"confirmDelivery","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"tokenId","type":"uint256"}],"name":"fundEscrow","outputs":[],"stateMutability":"payable","type":"function"},{"inputs":[{"internalType":"uint256","name":"tokenId","type":"uint256"}],"name":"getListingPrice","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"tokenId","type":"uint256"},{"internalType":"uint256","name":"priceInWei","type":"uint256"}],"name":"listAsset","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"","type":"uint256"}],"name":"listings","outputs":[{"internalType":"address","name":"seller","type":"address"},{"internalType":"address","name":"buyer","type":"address"},{"internalType":"uint256","name":"price","type":"uint256"},{"internalType":"enum Escrow.ListingState","name":"state","type":"uint8"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"tokenId","type":"uint256"}],"name":"refundBuyer","outputs":[],"stateMutability":"nonpayable","type":"function"}];
            const escrowContract = new ethers.Contract(escrowAddress, escrowAbi, signer);

            const listingDoc = await db.collection("listings").doc(listingId).get();
            if (!listingDoc.exists) {
              throw new HttpsError("not-found", "This listing is no longer available.");
            }
            const listingData = listingDoc.data();
            const priceTinybars = listingData.priceTinybars;

            const tx = await escrowContract.fundEscrow(listingData.serialNumber, {
                value: ethers.parseUnits(priceTinybars.toString(), "wei"), // price is in tinybars which is 1-to-1 with wei for HBAR
                gasLimit: 1_000_000
            });

            await tx.wait(); // Wait for the transaction to be mined

            // 4. Update the listing state in Firestore
            await db.collection("listings").doc(listingId).update({
                state: "FUNDED",
                buyerAccountId: accountId
            });

            // 5. Send SMS notification to seller
            const sellerAccountId = listingData.sellerAccountId;
            const smsRef = db.collection(`sms_inbox/${sellerAccountId}/messages`);
            await smsRef.add({
                text: `Your item "${listingName}" has been purchased by ${accountId}. Please arrange for delivery.`,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });

            responseText = `END You have successfully purchased "${listingName}". You will be notified when the seller confirms.`;
            await sessionsRef.doc(accountId).set({ currentMenu: 'MAIN', page: 0 });

        } catch (error) {
            console.error("ERROR during USSD fundEscrow:", error);
            responseText = "END Transaction failed. Please try again.";
            await sessionsRef.doc(accountId).set({ currentMenu: 'MAIN', page: 0 });
        }
    } else {
        responseText = `END Purchase of "${listingName}" cancelled.`;
        await sessionsRef.doc(accountId).set({ currentMenu: 'MAIN', page: 0 });
    }
  }
  else if (currentMenu === 'MARKETPLACE') {
    const page = sessionData.page || 0;
    const lastVisibleId = sessionData.lastVisible;
    const displayedListings = sessionData.listings || [];
    const selection = parseInt(text, 10);

    if (text === '99') { // Next Page
        const newPage = page + 1;
        let query = db.collection("listings").where("state", "==", "LISTED").orderBy("createdAt", "desc").limit(5);
        if (lastVisibleId) {
            const lastDoc = await db.collection("listings").doc(lastVisibleId).get();
            query = query.startAfter(lastDoc);
        }
        const listings = await query.get();

        if (listings.empty) {
            responseText = `END No more listings available.`;
        } else {
            let menuText = "CON Marketplace Listings:\n";
            const listingsData = [];
            listings.forEach((doc, index) => {
                const data = doc.data();
                const priceInHbar = data.priceTinybars / 100_000_000;
                menuText += `${index + 1}. ${data.name} (${priceInHbar} HBAR)\n`;
                listingsData.push({ id: doc.id, ...data });
            });
            menuText += `99. Next Page`;
            responseText = menuText;

            const newLastVisible = listings.docs[listings.docs.length - 1].id;
            await sessionsRef.doc(accountId).set({ ...sessionData, page: newPage, lastVisible: newLastVisible, listings: listingsData });
        }
    } else if (selection >= 1 && selection <= displayedListings.length) {
        // --- Buy Item Flow ---
        const selectedListing = displayedListings[selection - 1];
        const priceInHbar = selectedListing.priceTinybars / 100_000_000;

        await sessionsRef.doc(accountId).set({
            currentMenu: 'BUY_CONFIRM',
            listingId: selectedListing.id,
            listingName: selectedListing.name,
            priceHbar: priceInHbar
        });
        responseText = `CON Buy "${selectedListing.name}" for ${priceInHbar} HBAR?\n1. Confirm\n2. Cancel`;
    } else {
        responseText = `CON Invalid input. Enter a listing number to buy, or 99 for the next page.`;
    }
  }

  return { text: responseText };
});
