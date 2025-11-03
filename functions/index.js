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
  TokenAssociateTransaction,
  AccountAllowanceApproveTransaction,
  ContractExecuteTransaction,
  ContractFunctionParameters,
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
const assetTokenId = "0.0.7134449";
const escrowContractId = "0.0.7152729";

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

      const acctTx = new AccountCreateTransaction()
        .setKey(newPubKey)
        .setInitialBalance(new Hbar(65));

      const acctSubmit = await acctTx.execute(client);
      const acctReceipt = await acctSubmit.getReceipt(client);
      const newAccountId = acctReceipt.accountId;
      if (!newAccountId) {
        throw new Error("Failed to create account; no account id returned.");
      }

      const rawHex = newPriv.toStringRaw(); // 64 hex chars
      const newPrivHex0x = "0x" + rawHex;
      const evmAddress = (new ethers.Wallet(newPrivHex0x)).address;

      console.log("createAccount: returning privateKey length:", newPrivHex0x.length, "evm:", evmAddress);

      return response.status(200).send({
        accountId: newAccountId.toString(),
        privateKey: newPrivHex0x,
        publicKey: newPriv.publicKey.toString(), // helpful for debugging; remove for prod
        evmAddress: evmAddress
      });

    } catch (error) {
      console.error("FATAL ERROR in createAccount function:", error);
      return response.status(500).send({ error: error.message });
    }
  });
});

exports.verifyKey = onRequest((req, res) => {
  cors(req, res, async () => {
    const { privateKey, evmAddress } = req.body;
    if (!privateKey || !evmAddress) return res.status(400).send({ ok: false, message: "missing" });
    try {
      const derived = (new ethers.Wallet(privateKey)).address.toLowerCase();
      return res.status(200).send({ ok: derived === evmAddress.toLowerCase(), derived });
    } catch (e) {
      return res.status(400).send({ ok: false, error: e.message });
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
      const supplyPrivateKey = PrivateKey.fromStringECDSA(rawSupplyKey);

      const client = Client.forTestnet().setOperator(adminId, adminPrivateKey);

      const metadata = Buffer.from(JSON.stringify({ assetType, quality, location }));
      if (metadata.length > 100) {
        throw new Error("Metadata exceeds 100 bytes limit.");
      }

      const mintTx = await new TokenMintTransaction()
        .setTokenId(assetTokenId)
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
        .addNftTransfer(assetTokenId, serialNumber, adminId, accountId)
        .freezeWith(client)
        .execute(client);

      const transferRx = await transferTx.getReceipt(client);

      if (transferRx.status.toString() !== 'SUCCESS') {
        throw new Error(`NFT transfer failed with status: ${transferRx.status.toString()}`);
      }

      return response.status(200).send({
        tokenId: assetTokenId,
        serialNumber: serialNumber
      });

    } catch (error) {
      console.error("ERROR minting RWA via USSD:", error);
      return response.status(500).send({ error: error.message });
    }
  });
});

exports.listProductFromUSSD = onRequest({ secrets: [hederaAdminAccountId, hederaAdminPrivateKey, hederaAdminSupplyKey] }, (request, response) => {
  cors(request, response, async () => {
    // DEBUG LOGGING: Print headers, rawBody and parsed body
    console.log("=== listProductFromUSSD: received request ===");
    try {
      console.log("headers:", JSON.stringify(request.headers || {}, null, 2));
    } catch (e) { console.log("headers log failed", e.message); }
    try {
      // rawBody is Buffer — log safe preview
      const raw = request.rawBody ? request.rawBody.toString('utf8') : null;
      console.log("rawBody (preview):", raw ? raw.slice(0, 200) : null);
    } catch (e) { console.log("rawBody log failed", e.message); }
    try {
      console.log("parsed body:", JSON.stringify(request.body || {}, null, 2));
    } catch (e) { console.log("parsed body log failed", e.message); }
    console.log("=== end request logging ===");
    if (request.method !== "POST") {
      return response.status(405).send("Method Not Allowed");
    }
    try {
      const body = request.body || {};
      const required = ['sellerAccountId', 'sellerPrivateKey', 'productName', 'price'];
      const missing = required.filter(k => body[k] === undefined || body[k] === null || body[k] === '');
      if (missing.length) {
        console.error("listProductFromUSSD: missing fields:", missing);
        return response.status(400).send({
          error: {
            message: "Missing required fields",
            missing
          }
        });
      }

      // Coerce & validate price
      const priceParsed = Number(body.price);
      if (!Number.isFinite(priceParsed) || priceParsed <= 0) {
        console.error("listProductFromUSSD: invalid price:", body.price);
        return response.status(400).send({
          error: { message: "Invalid price: must be positive number", received: body.price }
        });
      }

      // Replace body.price with normalized number for further logic
      body.price = priceParsed;
      const {
        sellerAccountId,
        sellerPrivateKey,
        productName,
        price,
        description,
        location
      } = body;

      // sanity: ensure sellerPrivateKey exists and appears to be ECDSA hex
      let sellerKeyRaw = body.sellerPrivateKey;
      if (!sellerKeyRaw) {
        return response.status(400).send({ error: { message: "Missing sellerPrivateKey" } });
      }
      if (sellerKeyRaw.startsWith('0x')) sellerKeyRaw = sellerKeyRaw.slice(2);
      if (!/^[0-9a-fA-F]{64}$/.test(sellerKeyRaw)) {
        console.error("listProductFromUSSD: sellerPrivateKey invalid format:", sellerKeyRaw);
        return response.status(400).send({ error: { message: "sellerPrivateKey invalid format; expected 0x + 64 hex chars" } });
      }
      let sellerPrivateKeyObj;
      try {
        sellerPrivateKeyObj = PrivateKey.fromStringECDSA(sellerKeyRaw);
      } catch (err) {
        console.error("listProductFromUSSD: PrivateKey.fromStringECDSA failed:", err.message);
        return response.status(400).send({ error: { message: "Invalid seller private key format." } });
      }

      console.log("About to execute Hedera calls with:", {
        assetTokenId: assetTokenId,
        sellerAccountId: sellerAccountId,
        listingPrice: price
      });

      // 1. Setup Client
      const client = Client.forTestnet();
      client.setOperator(sellerAccountId, sellerPrivateKeyObj);

      // 2. Associate Token
      const associateTx = await new TokenAssociateTransaction()
        .setAccountId(sellerAccountId)
        .setTokenIds([assetTokenId])
        .execute(client);
      await associateTx.getReceipt(client);

      // 3. Mint NFT (as admin)
      const adminId = hederaAdminAccountId.value();
      const adminKey = PrivateKey.fromStringECDSA(hederaAdminPrivateKey.value());
      const supplyKey = PrivateKey.fromStringECDSA(hederaAdminSupplyKey.value());

      const adminClient = Client.forTestnet();
      adminClient.setOperator(adminId, adminKey);

      const mintTx = await new TokenMintTransaction()
        .setTokenId(assetTokenId)
        .setMetadata([Buffer.from(description)])
        .freezeWith(adminClient);
      const signedMintTx = await mintTx.sign(supplyKey);
      const mintSubmit = await signedMintTx.execute(adminClient);
      const mintRx = await mintSubmit.getReceipt(adminClient);
      const serialNumber = mintRx.serials[0].low;

      // 4. Approve Escrow Contract
      const approveTx = await new AccountAllowanceApproveTransaction()
        .approveTokenNftAllowance(assetTokenId, sellerAccountId, escrowContractId, [serialNumber])
        .execute(client);
      await approveTx.getReceipt(client);

      // 5. List on Escrow
      const listTx = await new ContractExecuteTransaction()
        .setContractId(escrowContractId)
        .setGas(1000000)
        .setFunction("listAsset", new ContractFunctionParameters().addUint256(serialNumber).addUint256(price * 10**8))
        .execute(client);
      await listTx.getReceipt(client);

      // 6. Save to Firestore
      const db = admin.firestore();
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

      response.status(200).send({ success: true, serialNumber });
    } catch (error) {
      console.error("Error in listProductFromUSSD:", error);
      response.status(500).send({ error: error.message });
    }
  });
});

exports.fundEscrowFromUSSD = onRequest((request, response) => {
  cors(request, response, async () => {
    if (request.method !== "POST") {
      return response.status(405).send("Method Not Allowed");
    }
    try {
      const { buyerAccountId, buyerPrivateKey, listingId, amount } = request.body;
      const [tokenId, serialNumber] = listingId.split('-');

      const client = Client.forTestnet();
      client.setOperator(buyerAccountId, PrivateKey.fromStringECDSA(buyerPrivateKey));

      const fundTx = await new ContractExecuteTransaction()
        .setContractId(escrowContractId)
        .setGas(1000000)
        .setPayableAmount(new Hbar(amount))
        .setFunction("fundEscrow", new ContractFunctionParameters().addUint256(serialNumber))
        .execute(client);

      await fundTx.getReceipt(client);

      const db = admin.firestore();
      await db.collection("listings").doc(listingId).update({
        state: 'FUNDED',
        buyerAccountId: buyerAccountId
      });

      response.status(200).send({ success: true });
    } catch (error) {
      console.error("Error in fundEscrowFromUSSD:", error);
      response.status(500).send({ error: error.message });
    }
  });
});

exports.confirmDeliveryFromUSSD = onRequest({ secrets: [hederaAdminAccountId, hederaAdminPrivateKey] }, (request, response) => {
  cors(request, response, async () => {
    if (request.method !== "POST") {
      return response.status(405).send("Method Not Allowed");
    }
    try {
      const { buyerAccountId, buyerPrivateKey, listingId } = request.body;
      const [tokenId, serialNumber] = listingId.split('-');

      const client = Client.forTestnet();
      client.setOperator(buyerAccountId, PrivateKey.fromStringECDSA(buyerPrivateKey));

      const confirmTx = await new ContractExecuteTransaction()
        .setContractId(escrowContractId)
        .setGas(1000000)
        .setFunction("confirmDelivery", new ContractFunctionParameters().addUint256(serialNumber))
        .execute(client);

      await confirmTx.getReceipt(client);

      // Update the listing in Firestore
      const db = admin.firestore();
      await db.collection("listings").doc(listingId).update({
        state: 'DELIVERED',
      });

      response.status(200).send({ success: true });
    } catch (error) {
      console.error("Error in confirmDeliveryFromUSSD:", error);
      response.status(500).send({ error: error.message });
    }
  });
});
