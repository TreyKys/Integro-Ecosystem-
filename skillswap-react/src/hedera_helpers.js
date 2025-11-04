import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;
import {
  PrivateKey,
  AccountId,
  Client,
  TokenAssociateTransaction,
  AccountAllowanceApproveTransaction,
  TokenId,
  NftId,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  Hbar,
  ContractCallQuery,
  TransferTransaction,
} from '@hashgraph/sdk';
import { db, doc, updateDoc } from './firebase';
import {
  escrowContractAccountId,
  assetTokenId,
  adminAccountId,
} from './hedera.js';

const handleTokenAssociation = async (accountId, privateKey) => {
    try {
      const userPrivateKey = PrivateKey.fromString(privateKey);
      const userAccountId = AccountId.fromString(accountId);
      const userClient = Client.forTestnet().setOperator(userAccountId, userPrivateKey);

      const associateTx = await new TokenAssociateTransaction()
        .setAccountId(userAccountId)
        .setTokenIds([assetTokenId])
        .freezeWith(userClient);

      const associateSign = await associateTx.sign(userPrivateKey);
      const associateSubmit = await associateSign.execute(userClient);
      const associateReceipt = await associateSubmit.getReceipt(userClient);

      if (associateReceipt.status.toString() !== 'SUCCESS') {
        throw new Error(`Token Association Failed with status: ${associateReceipt.status.toString()}`);
      }
    } catch (err) {
      if (!err.message.includes('TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT')) {
        throw err;
      }
    }
};

export const handleList = async (accountId, privateKey, price, serialToUse) => {
    if (!assetTokenId) {
      console.error("handleList Error: assetTokenId is not set. Please check hedera.js");
      throw new Error("Configuration error: assetTokenId is missing.");
    }
    if (serialToUse === null || serialToUse === undefined) {
      console.error("handleList Error: nftSerialNumber is not set. Minting may have failed.");
      throw new Error("State error: nftSerialNumber is missing.");
    }
    console.log(`handleList: Listing NFT ${assetTokenId} - Serial: ${serialToUse} for price: ${price}`);

    const userPrivateKey = PrivateKey.fromString(privateKey);
    const userAccountId = AccountId.fromString(accountId);
    const userClient = Client.forTestnet().setOperator(userAccountId, userPrivateKey);

    const tokenIdObj = TokenId.fromString(assetTokenId);
    const nftIdObj = new NftId(tokenIdObj, Number(serialToUse));

    const allowanceTx = new AccountAllowanceApproveTransaction()
      .approveTokenNftAllowance(nftIdObj, userAccountId, escrowContractAccountId)
      .approveTokenNftAllowance(nftIdObj, userAccountId, adminAccountId);

    console.log("Granting allowances to escrow contract and admin account...");
    const frozenTx = await allowanceTx.freezeWith(userClient);
    const signedTx = await frozenTx.sign(userPrivateKey);
    const txResponse = await signedTx.execute(userClient);

    const receipt = await txResponse.getReceipt(userClient);
    if (receipt.status.toString() !== 'SUCCESS') {
      throw new Error(`Allowance approval failed with status: ${receipt.status.toString()}`);
    }
    console.log("Allowances granted successfully.");

    const priceInWei = Hbar.from(price).toTinybars();
    const listAssetTx = new ContractExecuteTransaction()
      .setContractId(escrowContractAccountId)
      .setGas(1000000)
      .setFunction("listAsset", new ContractFunctionParameters()
        .addUint256(serialToUse)
        .addUint256(priceInWei)
      );

    const frozenListTx = await listAssetTx.freezeWith(userClient);
    const signedListTx = await frozenListTx.sign(userPrivateKey);
    const listTxResponse = await signedListTx.execute(userClient);

    await listTxResponse.getReceipt(userClient);

    return listTxResponse;
};

export const handleBuy = async (accountId, privateKey, listing) => {
    await handleTokenAssociation(accountId, privateKey);

    const userPrivateKey = PrivateKey.fromString(privateKey);
    const userAccountId = AccountId.fromString(accountId);
    const userClient = Client.forTestnet().setOperator(userAccountId, userPrivateKey);

    const getListingQuery = new ContractCallQuery()
      .setContractId(escrowContractAccountId)
      .setGas(100000)
      .setFunction("listings", new ContractFunctionParameters().addUint256(listing.serialNumber));

    const listingInfo = await getListingQuery.execute(userClient);
    const priceInTinybarsLong = listingInfo.getUint256(2);

    if (priceInTinybarsLong.isZero()) {
      throw new Error("This asset is not currently listed for sale or has a price of zero.");
    }

    const priceInTinybars = priceInTinybarsLong.toString();

    const fundTx = new ContractExecuteTransaction()
      .setContractId(escrowContractAccountId)
      .setGas(1000000)
      .setPayableAmount(Hbar.fromTinybars(priceInTinybars))
      .setFunction("fundEscrow", new ContractFunctionParameters().addUint256(listing.serialNumber));

    const frozenFundTx = await fundTx.freezeWith(userClient);
    const signedFundTx = await frozenFundTx.sign(userPrivateKey);
    const fundTxResponse = await signedFundTx.execute(userClient);
    const fundTxReceipt = await fundTxResponse.getReceipt(userClient);

    if (fundTxReceipt.status.toString() !== 'SUCCESS') {
      throw new Error(`Escrow funding failed with status: ${fundTxReceipt.status.toString()}`);
    }

    const listingRef = doc(db, 'listings', listing.id);
    await updateDoc(listingRef, {
      status: 'Pending Delivery',
      buyerAccountId: accountId
    });

    return fundTxResponse;
};

export const confirmDelivery = async (accountId, privateKey, listing) => {
    if (!listing || typeof listing.serialNumber === 'undefined' || listing.serialNumber === null || !listing.id || !listing.sellerAccountId) {
        console.error("confirmDelivery Error: Invalid 'listing' object provided.", listing);
        throw new Error("Cannot confirm delivery: required asset information is missing.");
    }

    const { id: listingId, serialNumber, sellerAccountId } = listing;

    const buyerPrivateKey = PrivateKey.fromString(privateKey);
    const buyerAccountId = AccountId.fromString(accountId);
    const buyerClient = Client.forTestnet().setOperator(buyerAccountId, buyerPrivateKey);

    const confirmTx = new ContractExecuteTransaction()
      .setContractId(escrowContractAccountId)
      .setGas(1000000)
      .setFunction("confirmDelivery", new ContractFunctionParameters().addUint256(serialNumber));

    const frozenConfirmTx = await confirmTx.freezeWith(buyerClient);
    const signedConfirmTx = await frozenConfirmTx.sign(buyerPrivateKey);
    const confirmTxResponse = await signedConfirmTx.execute(buyerClient);
    const confirmReceipt = await confirmTxResponse.getReceipt(buyerClient);

    if (confirmReceipt.status.toString() !== 'SUCCESS') {
        throw new Error(`Payment release failed with status: ${confirmReceipt.status.toString()}`);
    }

    const adminPrivKeyString = import.meta.env.VITE_ADMIN_PRIVATE_KEY;
    if (!adminPrivKeyString) {
      throw new Error("Admin private key is not configured.");
    }
    const adminPrivKey = PrivateKey.fromStringECDSA(adminPrivKeyString);
    const adminClient = Client.forTestnet().setOperator(adminAccountId, adminPrivKey);

    const transferTx = new TransferTransaction()
      .addApprovedNftTransfer(new NftId(TokenId.fromString(assetTokenId), serialNumber), sellerAccountId, buyerAccountId)
      .freezeWith(adminClient);

    const signedTransferTx = await transferTx.sign(adminPrivKey);
    const transferResponse = await signedTransferTx.execute(adminClient);
    const transferReceipt = await transferResponse.getReceipt(adminClient);

    if (transferReceipt.status.toString() !== 'SUCCESS') {
        throw new Error(`NFT Transfer failed with status: ${transferReceipt.status.toString()}`);
    }

    const listingRef = doc(db, 'listings', listingId);
    await updateDoc(listingRef, { status: 'Delivered' });
};
