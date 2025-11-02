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
  ContractCallQuery
} from '@hashgraph/sdk';
import { db, collection, addDoc, Timestamp, doc, getDoc, query, where, getDocs, updateDoc } from '../firebase';
import {
  escrowContractAccountId,
  assetTokenId,
  lendingPoolContractAccountId,
} from '../hedera.js';

const mintRwaViaUssdUrl = "https://mintrwaviaussd-cehqwvb4aq-uc.a.run.app";

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
    if (currentSerial === null || currentSerial === undefined) {
      console.error("handleList called without a serial number.");
      throw new Error("State error: nftSerialNumber is missing.");
    }
    console.log(`handleList: Starting listing for serial ${currentSerial} at price ${price} HBAR.`);

    const rawPrivKey = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
    const userPrivateKey = PrivateKey.fromStringECDSA(rawPrivKey);
    const userAccountId = AccountId.fromString(accountId);
    const userClient = Client.forTestnet().setOperator(userAccountId, userPrivateKey);
    console.log(`handleList: Client configured for seller: ${userAccountId}.`);

    // Step 1: Approve the escrow contract to transfer the NFT
    console.log(`handleList: Approving escrow contract ${escrowContractAccountId} for NFT...`);
    try {
      const approveTx = new AccountAllowanceApproveTransaction()
        .approveTokenNftAllowance(new NftId(TokenId.fromString(assetTokenId), currentSerial), userAccountId, AccountId.fromString(escrowContractAccountId));

      const frozenApproveTx = await approveTx.freezeWith(userClient);
      const signedApproveTx = await frozenApproveTx.signWithOperator(userClient);
      const approveTxResponse = await signedApproveTx.execute(userClient);
      console.log("handleList: Approval transaction submitted. Waiting for receipt...");
      const approveReceipt = await approveTxResponse.getReceipt(userClient);
      console.log(`handleList: Approval transaction status: ${approveReceipt.status.toString()}`);
      if (approveReceipt.status.toString() !== 'SUCCESS') {
        throw new Error(`NFT Approval failed with status: ${approveReceipt.status.toString()}`);
      }
    } catch (error) {
      console.error("handleList: Error during NFT approval:", error);
      throw error;
    }

    // Step 2: List the asset on the escrow contract
    console.log(`handleList: Listing asset on contract ${escrowContractAccountId}...`);
    try {
      const priceInTinybars = Hbar.from(price).toTinybars();
      console.log(`handleList: Price in tinybars: ${priceInTinybars.toString()}`);

      const listAssetTx = new ContractExecuteTransaction()
        .setContractId(escrowContractAccountId)
        .setGas(1000000)
        .setFunction("listAsset", new ContractFunctionParameters()
          .addUint256(BigInt(currentSerial))
          .addUint256(BigInt(priceInTinybars.toString()))
        );

      const frozenListAssetTx = await listAssetTx.freezeWith(userClient);
      const signedListAssetTx = await frozenListAssetTx.signWithOperator(userClient);
      const listAssetTxResponse = await signedListAssetTx.execute(userClient);
      console.log("handleList: ListAsset transaction submitted. The calling function will await the receipt.");

      // The calling function will await the receipt
      setFlowState("LISTED");
      return listAssetTxResponse; // Return the response object
    } catch (error) {
      console.error("handleList: Error during contract execution for listAsset:", error);
      throw error;
    }
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
    const rawPrivKey = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
    const userPrivateKey = PrivateKey.fromStringECDSA(rawPrivKey);
    const userAccountId = AccountId.fromString(accountId);
    const userClient = Client.forTestnet().setOperator(userAccountId, userPrivateKey);

    const getPriceQuery = new ContractCallQuery()
      .setContractId(escrowContractAccountId)
      .setGas(100000)
      .setFunction("getListingPrice", new ContractFunctionParameters().addUint256(listing.serialNumber));

    const priceQueryResult = await getPriceQuery.execute(userClient);
    const priceInTinybarsLong = priceQueryResult.getUint256(0);

    if (priceInTinybarsLong.isZero()) {
      throw new Error("This asset is not currently listed for sale or has a price of zero.");
    }

    const priceInTinybars = priceInTinybarsLong.toNumber();

    const fundTx = new ContractExecuteTransaction()
      .setContractId(escrowContractAccountId)
      .setGas(1000000)
      .setPayableAmount(Hbar.fromTinybars(priceInTinybars))
      .setFunction("fundEscrow", new ContractFunctionParameters().addUint256(listing.serialNumber));

    const frozenFundTx = await fundTx.freezeWith(userClient);
    const signedFundTx = await frozenFundTx.sign(userPrivateKey);
    const fundTxResponse = await signedFundTx.execute(userClient);
    await fundTxResponse.getReceipt(userClient);

    const listingRef = doc(db, 'listings', listing.id);
    await updateDoc(listingRef, {
      status: 'Pending Delivery',
      buyerAccountId: accountId
    });

    setFlowState("FUNDED");
    return fundTxResponse;
  };

  const confirmDelivery = async (listingId, serialNumber) => {
    const rawPrivKey = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
    const userPrivateKey = PrivateKey.fromStringECDSA(rawPrivKey);
    const userAccountId = AccountId.fromString(accountId);
    const userClient = Client.forTestnet().setOperator(userAccountId, userPrivateKey);

    const confirmTx = new ContractExecuteTransaction()
      .setContractId(escrowContractAccountId)
      .setGas(1000000)
      .setFunction("confirmDelivery", new ContractFunctionParameters().addUint256(serialNumber));

    const frozenConfirmTx = await confirmTx.freezeWith(userClient);
    const signedConfirmTx = await frozenConfirmTx.sign(userPrivateKey);
    const confirmTxResponse = await signedConfirmTx.execute(userClient);
    await confirmTxResponse.getReceipt(userClient);

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
