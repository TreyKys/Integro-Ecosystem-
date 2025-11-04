import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;
import React, { createContext, useState, useEffect, useContext, useCallback } from 'react';
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
  AccountBalanceQuery,
  ContractCallQuery,
  TransferTransaction
} from '@hashgraph/sdk';
import { db, collection, addDoc, Timestamp, doc, getDoc, query, where, getDocs, updateDoc } from '../firebase';
import {
  escrowContractAccountId,
  assetTokenId,
  lendingPoolContractAccountId,
  adminAccountId,
  getNftOwner,
} from '../hedera.js';

const mintRwaViaUssdUrl = "https://mintrwaviaussd-cehqwvb4aq-uc.a.run.app";
const executeNativeNftTransferUrl = "https://executenativenfttransfer-cehqwvb4aq-uc.a.run.app";

// Create the context
export const WalletContext = createContext(null);

// Create a provider component
export const WalletProvider = ({ children }) => {
  const [accountId, setAccountId] = useState(null);
  const [evmAddress, setEvmAddress] = useState(null);
  const [privateKey, setPrivateKey] = useState(null);
  const [hbarBalance, setHbarBalance] = useState(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [userProfile, setUserProfile] = useState(null);
  const [isProfileLoading, setIsProfileLoading] = useState(true);
  const [flowState, setFlowState] = useState('INITIAL');
  const [verifying, setVerifying] = useState(false);
  const [nftSerialNumber, setNftSerialNumber] = useState(null);

  const fetchBalance = useCallback(async (id) => {
    if (!id) return;
    try {
      const client = Client.forTestnet();
      const query = new AccountBalanceQuery().setAccountId(id);
      const accountBalance = await query.execute(client);
      setHbarBalance(accountBalance.hbars.toString());
    } catch (error) {
      console.error("Failed to fetch HBAR balance:", error);
      setHbarBalance("Error");
    }
  }, []);

  // On component mount, try to load the wallet from localStorage
  useEffect(() => {
    const storedKey = localStorage.getItem('integro-private-key');
    const storedAccountId = localStorage.getItem('integro-account-id');
    const storedEvmAddress = localStorage.getItem('integro-evm-address');

    if (storedKey && storedAccountId && storedEvmAddress) {
      console.log("WalletContext: Restoring wallet from localStorage.");
      setPrivateKey(storedKey);
      setAccountId(storedAccountId);
      setEvmAddress(storedEvmAddress);
      fetchBalance(storedAccountId);
    }
    setIsLoaded(true);
  }, [fetchBalance]);

  useEffect(() => {
    if (accountId) {
      const interval = setInterval(() => {
        fetchBalance(accountId);
      }, 30000); // Refresh every 30 seconds

      return () => clearInterval(interval);
    }
  }, [accountId, fetchBalance]);

  const fetchUserProfile = useCallback(async () => {
    if (!accountId) {
      // If there's no accountId, there's no profile to fetch.
      setIsProfileLoading(false);
      return;
    }
    setIsProfileLoading(true);
    console.log("WalletContext: Fetching user profile for", accountId);
    try {
      const userDocRef = doc(db, 'users', accountId);
      const userDocSnap = await getDoc(userDocRef);
      if (userDocSnap.exists()) {
        console.log("WalletContext: User profile found.");
        setUserProfile(userDocSnap.data());
      } else {
        console.log("WalletContext: User profile not found.");
        setUserProfile(null);
      }
    } catch (error) {
      console.error("Error fetching user profile:", error);
      setUserProfile(null);
    } finally {
      setIsProfileLoading(false);
    }
  }, [accountId]);

  // Fetch profile whenever accountId changes.
  useEffect(() => {
    fetchUserProfile();
  }, [fetchUserProfile]);

  const refreshUserProfile = async () => {
    await fetchUserProfile();
  };

  // This function will be called by the onboarding flow to set the new vault details
  const createVault = (newAccountId, newPrivateKey, newEvmAddress) => {
    console.log("WalletContext: createVault called with", newAccountId);
    // 1. Save to localStorage
    localStorage.setItem('integro-private-key', newPrivateKey);
    localStorage.setItem('integro-account-id', newAccountId);
    localStorage.setItem('integro-evm-address', newEvmAddress);

    // 2. Update state
    console.log("WalletContext: Setting new accountId:", newAccountId);
    setPrivateKey(newPrivateKey);
    setAccountId(newAccountId);
    setEvmAddress(newEvmAddress);
    console.log("WalletContext: State update complete.");
  };

  // This function will allow components to clear the vault
  const logout = () => {
    localStorage.removeItem('integro-private-key');
    localStorage.removeItem('integro-account-id');
    localStorage.removeItem('integro-evm-address');
    setPrivateKey(null);
    setAccountId(null);
    setEvmAddress(null);
  };

  const handleTokenAssociation = async () => {
    try {
      const rawPrivKey = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
      const userPrivateKey = PrivateKey.fromStringECDSA(rawPrivKey);
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

  const handleMint = async (assetType, quality, location) => {
    await handleTokenAssociation();
    const response = await fetch(mintRwaViaUssdUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: accountId,
        assetType,
        quality,
        location
      }),
    });

    const data = await response.json();
    console.log("handleMint: Received data from backend:", data);
    if (!response.ok) {
      console.error("Backend minting request failed. Raw response:", data);
      throw new Error(data.error || 'Backend minting request failed.');
    }

    const { serialNumber } = data;
    setNftSerialNumber(serialNumber);
    setFlowState('MINTED');
    return serialNumber;
  };

  const handleMintAndList = async (listingData) => {
    await handleTokenAssociation();

    const { name, description, price, category, imageUrl } = listingData;

    // 1. Mint the NFT via backend
    const mintResponse = await fetch(mintRwaViaUssdUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: accountId,
        assetType: name,
        quality: "N/A",
        location: "N/A",
      }),
    });

    const mintData = await mintResponse.json();
    if (!mintResponse.ok) {
      throw new Error(mintData.error || 'Backend minting request failed.');
    }
    const { serialNumber } = mintData;
    setNftSerialNumber(serialNumber); // Set serial number for handleList
    setFlowState('MINTED');

    // 2. List on-chain
    const listTxResponse = await handleList(price, serialNumber);

    // 3. Save to Firestore with 'Pending Confirmation' status
    const listingRef = await addDoc(collection(db, "listings"), {
      tokenId: assetTokenId,
      serialNumber: Number(serialNumber),
      name,
      description,
      price: Hbar.from(price).toTinybars().toString(),
      category,
      sellerAccountId: accountId,
      sellerEvmAddress: evmAddress,
      imageUrl,
      createdAt: Timestamp.now(),
      status: 'Pending Confirmation', // Initial status
    });

    const rawPrivKey = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
    const userPrivateKey = PrivateKey.fromStringECDSA(rawPrivKey);
    const userAccountId = AccountId.fromString(accountId);
    const userClient = Client.forTestnet().setOperator(userAccountId, userPrivateKey);
    // Wait for the on-chain listing receipt
    await listTxResponse.getReceipt(userClient);

    // 4. Update status to 'Listed' after on-chain confirmation
    await updateDoc(listingRef, {
      status: 'Listed',
    });


    setFlowState("LISTED");
    return { serialNumber };
  };

  const handleList = async (price, serialToUse) => {
    const currentSerial = serialToUse || nftSerialNumber;
    // --- Defensive Programming: Check for null values ---
    if (!assetTokenId) {
      console.error("handleList Error: assetTokenId is not set. Please check hedera.js");
      throw new Error("Configuration error: assetTokenId is missing.");
    }
    if (currentSerial === null || currentSerial === undefined) {
      console.error("handleList Error: nftSerialNumber is not set. Minting may have failed.");
      throw new Error("State error: nftSerialNumber is missing.");
    }
    console.log(`handleList: Listing NFT ${assetTokenId} - Serial: ${currentSerial} for price: ${price}`);

    const rawPrivKey = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
    const userPrivateKey = PrivateKey.fromStringECDSA(rawPrivKey);
    const userAccountId = AccountId.fromString(accountId);
    const userClient = Client.forTestnet().setOperator(userAccountId, userPrivateKey);

    const tokenIdObj = TokenId.fromString(assetTokenId);
    const nftIdObj = new NftId(tokenIdObj, Number(currentSerial));

    const allowanceTx = new AccountAllowanceApproveTransaction()
      .approveTokenNftAllowance(nftIdObj, userAccountId, escrowContractAccountId)
      .approveTokenNftAllowance(nftIdObj, userAccountId, adminAccountId);

    console.log("Granting allowances to escrow contract and admin account...");
    const frozenTx = await allowanceTx.freezeWith(userClient);
    const signedTx = await frozenTx.sign(userPrivateKey);
    const txResponse = await signedTx.execute(userClient);

    // Explicitly wait for the receipt to ensure the allowance is confirmed
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
        .addUint256(currentSerial)
        .addUint256(priceInWei)
      );

    const frozenListTx = await listAssetTx.freezeWith(userClient);
    const signedListTx = await frozenListTx.sign(userPrivateKey);
    const listTxResponse = await signedListTx.execute(userClient);

    // Note: We await the receipt in the calling function now.

    setFlowState("LISTED");
    return listTxResponse;
  };

  const approveNFTForPool = async (serialNumber) => {
    console.log(`approveNFTForPool: Approving NFT ${assetTokenId} - Serial: ${serialNumber} for pool: ${lendingPoolContractAccountId}`);

    const rawPrivKey = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
    const userPrivateKey = PrivateKey.fromStringECDSA(rawPrivKey);
    const userAccountId = AccountId.fromString(accountId);
    const client = Client.forTestnet().setOperator(userAccountId, userPrivateKey);

    const tokenIdObj = TokenId.fromString(assetTokenId);
    const nftId = new NftId(tokenIdObj, Number(serialNumber));

    const allowanceTx = new AccountAllowanceApproveTransaction()
      .approveTokenNftAllowance(nftId, userAccountId, lendingPoolContractAccountId)
      .freezeWith(client);

    const signed = await allowanceTx.sign(userPrivateKey);
    const resp = await signed.execute(client);
    const receipt = await resp.getReceipt(client);

    console.log(`- NFT Approval transaction status: ${receipt.status.toString()}`);
    return receipt.status.toString();
  }

  const callTakeLoan = async (tokenId, principal, interest, durationSeconds) => {
    await approveNFTForPool(tokenId);

    const principalTinybars = Hbar.from(principal).toTinybars();
    const interestTinybars = Hbar.from(interest).toTinybars();

    const rawPrivKey = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
    const userPrivateKey = PrivateKey.fromStringECDSA(rawPrivKey);
    const userAccountId = AccountId.fromString(accountId);
    const client = Client.forTestnet().setOperator(userAccountId, userPrivateKey);

    const tx = await new ContractExecuteTransaction()
      .setContractId(lendingPoolContractAccountId)
      .setGas(250_000)
      .setFunction("takeLoan",
        new ContractFunctionParameters()
          .addUint256(tokenId)
          .addUint256(principalTinybars.toNumber()) // Convert to number
          .addUint256(interestTinybars.toNumber())  // Convert to number
          .addUint256(durationSeconds)
      )
      .execute(client);

    const receipt = await tx.getReceipt(client);
    if (receipt.status.toString() === 'SUCCESS') {
      await addDoc(collection(db, "loans"), {
        tokenId: Number(tokenId),
        borrowerAccountId: accountId,
        principalTinybars: principalTinybars.toString(),
        interestTinybars: interestTinybars.toString(),
        dueTime: new Date(Date.now() + durationSeconds * 1000),
        state: "ACTIVE",
        createdAt: Timestamp.now()
      });
    }
    return receipt;
  }

  const liquidateLoanAsAdmin = async (tokenId, destAddress) => {
    const rawPrivKey = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
    const adminPrivateKey = PrivateKey.fromStringECDSA(rawPrivKey);
    const adminAccountId = AccountId.fromString(accountId);
    const client = Client.forTestnet().setOperator(adminAccountId, adminPrivateKey);

    const tx = await new ContractExecuteTransaction()
      .setContractId(lendingPoolContractAccountId)
      .setFunction("liquidateLoan", new ContractFunctionParameters()
         .addUint256(tokenId)
         .addAddress(destAddress)
      )
      .setGas(200_000)
      .execute(client);

    const receipt = await tx.getReceipt(client);
    if (receipt.status.toString() === 'SUCCESS') {
      const q = query(collection(db, "loans"), where("tokenId", "==", Number(tokenId)));
      const querySnapshot = await getDocs(q);
      querySnapshot.forEach((doc) => {
        updateDoc(doc.ref, { state: "REPAID" });
      });
    }
    return receipt;
  }

  const depositLiquidityAsAdmin = async (amount) => {
    const amountTinybars = Hbar.from(amount).toTinybars();

    const rawPrivKey = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
    const adminPrivateKey = PrivateKey.fromStringECDSA(rawPrivKey);
    const adminAccountId = AccountId.fromString(accountId);
    const client = Client.forTestnet().setOperator(adminAccountId, adminPrivateKey);

    const tx = await new ContractExecuteTransaction()
      .setContractId(lendingPoolContractAccountId)
      .setFunction("depositLiquidity", new ContractFunctionParameters())
      .setGas(100_000)
      .setPayableAmount(Hbar.fromTinybars(amountTinybars))
      .execute(client);

    const receipt = await tx.getReceipt(client);
    if (receipt.status.toString() === 'SUCCESS') {
      const q = query(collection(db, "loans"), where("tokenId", "==", Number(tokenId)));
      const querySnapshot = await getDocs(q);
      querySnapshot.forEach((doc) => {
        updateDoc(doc.ref, { state: "LIQUIDATED" });
      });
    }
    return receipt;
  }

  const callRepayLoan = async (tokenId, repayAmount) => {
    const repayTinybars = Hbar.from(repayAmount).toTinybars();

    const rawPrivKey = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
    const userPrivateKey = PrivateKey.fromStringECDSA(rawPrivKey);
    const userAccountId = AccountId.fromString(accountId);
    const client = Client.forTestnet().setOperator(userAccountId, userPrivateKey);

    const tx = await new ContractExecuteTransaction()
      .setContractId(lendingPoolContractAccountId)
      .setGas(250_000)
      .setFunction("repayLoan", new ContractFunctionParameters().addUint256(tokenId))
      .setPayableAmount(Hbar.fromTinybars(repayTinybars))
      .execute(client);

    const receipt = await tx.getReceipt(client);
    return receipt;
  }

  const handleBuy = async (listing) => {
    // Ensure the buyer is associated with the token before purchasing.
    await handleTokenAssociation();

    const rawPrivKey = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
    const userPrivateKey = PrivateKey.fromStringECDSA(rawPrivKey);
    const userAccountId = AccountId.fromString(accountId);
    const userClient = Client.forTestnet().setOperator(userAccountId, userPrivateKey);

    const getListingQuery = new ContractCallQuery()
      .setContractId(escrowContractAccountId)
      .setGas(100000)
      .setFunction("listings", new ContractFunctionParameters().addUint256(listing.serialNumber));

    const listingInfo = await getListingQuery.execute(userClient);
    // The price is the 3rd element (index 2) in the returned struct
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

    setFlowState("FUNDED");
    return fundTxResponse;
  };

  const confirmDelivery = async (listing) => {
    if (!listing || typeof listing.serialNumber === 'undefined' || listing.serialNumber === null || !listing.id || !listing.sellerAccountId) {
        console.error("confirmDelivery Error: Invalid 'listing' object provided.", listing);
        throw new Error("Cannot confirm delivery: required asset information is missing.");
    }

    const { id: listingId, serialNumber, sellerAccountId } = listing;

    // 1. Set up the buyer's client to release funds
    const rawBuyerPrivKey = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
    const buyerPrivateKey = PrivateKey.fromStringECDSA(rawBuyerPrivKey);
    const buyerAccountId = AccountId.fromString(accountId);
    const buyerClient = Client.forTestnet().setOperator(buyerAccountId, buyerPrivateKey);

    // 2. Call the smart contract to release the HBAR payment to the seller
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

    // 3. Set up an ADMIN client to perform the transfer (using the allowance)
    // This is secure because the seller granted an allowance to the admin account during listing.
    const adminPrivKeyString = import.meta.env.VITE_ADMIN_PRIVATE_KEY;
    if (!adminPrivKeyString) {
      throw new Error("Admin private key is not configured.");
    }
    const adminPrivKey = PrivateKey.fromStringECDSA(adminPrivKeyString);
    const adminClient = Client.forTestnet().setOperator(adminAccountId, adminPrivKey);

    // 4. Execute the native NFT transfer from seller to buyer
    const transferTx = new TransferTransaction()
      .addApprovedNftTransfer(new NftId(TokenId.fromString(assetTokenId), serialNumber), sellerAccountId, buyerAccountId)
      .freezeWith(adminClient);

    const signedTransferTx = await transferTx.sign(adminPrivKey);
    const transferResponse = await signedTransferTx.execute(adminClient);
    const transferReceipt = await transferResponse.getReceipt(adminClient);

    if (transferReceipt.status.toString() !== 'SUCCESS') {
        throw new Error(`NFT Transfer failed with status: ${transferReceipt.status.toString()}`);
    }

    // 5. Update Firestore and local state
    const listingRef = doc(db, 'listings', listingId);
    await updateDoc(listingRef, { status: 'Delivered' });
    setFlowState("COMPLETED");
  };

  const value = {
    accountId,
    evmAddress,
    privateKey,
    hbarBalance,
    isLoaded,
    userProfile,
    isProfileLoading,
    flowState,
    verifying,
    nftSerialNumber,
    createVault,
    logout,
    refreshUserProfile,
    handleTokenAssociation,
    handleMint,
    handleList,
    handleMintAndList,
    approveNFTForPool,
    callTakeLoan,
    callRepayLoan,
    depositLiquidityAsAdmin,
    liquidateLoanAsAdmin,
    confirmDelivery,
    handleBuy,
  };
  return (
    <WalletContext.Provider value={value}>
      {children}
    </WalletContext.Provider>
  );
};

// Custom hook to use the wallet context
export const useWallet = () => {
  const context = useContext(WalletContext);
  if (context === undefined) {
    throw new Error('useWallet must be used within a WalletProvider');
  }
  return context;
};
