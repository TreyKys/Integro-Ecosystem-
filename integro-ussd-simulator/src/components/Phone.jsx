import React, { useState } from 'react';
import { db, createAccount, setUserProfile, mintRWAviaUSSD, executeNativeNftTransfer } from '../firebase';
import { collection, addDoc, serverTimestamp, query, getDocs, orderBy, limit, doc, getDoc, updateDoc } from "firebase/firestore";

const Phone = ({ setMessages }) => {

  const [screenText, setScreenText] = useState('Welcome! Dial *878*1# to begin.');
  const [dialerInput, setDialerInput] = useState('');
  const [currentMenu, setCurrentMenu] = useState('home');
  const [sessionData, setSessionData] = useState({});
  const [userAccount, setUserAccount] = useState(null);

  const handleCreateAccount = async () => {
    setScreenText('Creating your account, please wait...');
    try {
      const result = await createAccount({ name: sessionData.name });
      const { accountId, privateKey, evmAddress } = result.data;

      await setUserProfile({ accountId, displayName: sessionData.name, role: "User", location: "USSD" });

      // Private key is now only stored in component state
      const newAccount = { accountId, privateKey, evmAddress, name: sessionData.name };
      setUserAccount(newAccount);

      const welcomeMessage = `Congratulations ${sessionData.name}! Your account is created.\n\nAccount ID: ${accountId}`;
      setScreenText(welcomeMessage + `\n\n1. List an Asset (*878*2#)\n2. View Marketplace (*878*3#)`);
      setCurrentMenu('loggedIn');
      setMessages(prev => [...prev, { text: `New Account Created: ${accountId}` }]);
      setSessionData({});

    } catch (error) {
      console.error("Error in handleCreateAccount:", error);
      setScreenText(`Error creating account: ${error.message}.`);
      setCurrentMenu('home');
    }
  };

  const handleMintAndList = async () => {
    setScreenText("Minting your asset, please wait...");
    try {
      const mintResult = await mintRWAviaUSSD({
        accountId: userAccount.accountId,
        assetType: sessionData.assetName,
        quality: "A",
        location: "USSD"
      });

      const { serialNumber, tokenId } = mintResult.data;
      setScreenText(`Minting successful! Serial: ${serialNumber}. Now listing...`);

      const docRef = await addDoc(collection(db, "listings"), {
        assetName: sessionData.assetName,
        price: sessionData.price,
        description: `Asset listed via USSD by ${userAccount.name}`,
        sellerAccountId: userAccount.accountId,
        sellerEvmAddress: userAccount.evmAddress,
        serialNumber: serialNumber,
        tokenId: tokenId,
        state: "AVAILABLE",
        createdAt: serverTimestamp(),
      });

      setScreenText(`Success! Your asset "${sessionData.assetName}" is now listed for ${sessionData.price} HBAR.\n\n1. List another Asset (*878*2#)\n2. View Marketplace (*878*3#)`);
      setMessages(prev => [...prev, { text: `New Listing: "${sessionData.assetName}" for ${sessionData.price} HBAR. ID: ${docRef.id}` }]);
      setCurrentMenu('loggedIn');
      setSessionData({});

    } catch (error) {
        console.error("Error during mint/list process:", error);
        setScreenText(`Error: ${error.message}. Please try again.`);
        setCurrentMenu('loggedIn');
    }
  }

  const handleViewMarketplace = async () => {
    setScreenText("Fetching marketplace listings...");
    try {
      const q = query(collection(db, "listings"), orderBy("createdAt", "desc"), limit(5));
      const querySnapshot = await getDocs(q);
      const listings = [];
      querySnapshot.forEach((doc) => {
        const data = doc.data();
        if (data.state === 'AVAILABLE') {
            listings.push({
              id: doc.id,
              text: `- ${data.assetName} (${data.price} HBAR). Buy: *878*4*${doc.id}#`
            });
        }
      });

      if (listings.length === 0) {
        setMessages([{ text: "The marketplace is empty." }]);
      } else {
        setMessages(listings);
      }

      setScreenText("Marketplace updated in SMS inbox.\n\n1. List an Asset (*878*2#)\n2. View Marketplace (*878*3#)");

    } catch (error) {
        console.error("Error fetching marketplace:", error);
        setScreenText(`Error: ${error.message}. Please try again.`);
    }
  }

  const handleBuyAsset = async (listingId) => {
    setScreenText(`Processing purchase for listing ${listingId}...`);
    try {
        const listingRef = doc(db, "listings", listingId);
        const listingSnap = await getDoc(listingRef);

        if (!listingSnap.exists() || listingSnap.data().state !== 'AVAILABLE') {
            setScreenText("Sorry, this item is not available for purchase.");
            return;
        }

        const listingData = listingSnap.data();
        if (listingData.sellerAccountId === userAccount.accountId) {
          setScreenText("You cannot buy your own item.");
          return;
        }

        await updateDoc(listingRef, {
            state: "FUNDED",
            buyerAccountId: userAccount.accountId
        });

        const sellerMessage = `Your item "${listingData.assetName}" has been purchased by ${userAccount.accountId}. Confirm delivery: *878*5*${listingId}#`;
        const buyerMessage = `You have purchased "${listingData.assetName}". Waiting for seller to confirm delivery.`;

        setMessages(prev => [...prev, { text: sellerMessage }, { text: buyerMessage }]);
        setScreenText(`Purchase successful! The seller has been notified to confirm delivery.`);

    } catch (error) {
        console.error("Error buying asset:", error);
        setScreenText(`Error: ${error.message}. Please try again.`);
    }
  };

  const handleConfirmDelivery = async (listingId) => {
    setScreenText(`Confirming delivery for listing ${listingId}...`);
    try {
        const listingRef = doc(db, "listings", listingId);
        const listingSnap = await getDoc(listingRef);

        if (!listingSnap.exists() || listingSnap.data().state !== 'FUNDED') {
            setScreenText("This item is not pending delivery confirmation.");
            return;
        }

        const listingData = listingSnap.data();
        if (listingData.sellerAccountId !== userAccount.accountId) {
          setScreenText("You are not the seller of this item.");
          return;
        }

        await executeNativeNftTransfer({
            sellerAccountId: listingData.sellerAccountId,
            buyerAccountId: listingData.buyerAccountId,
            serialNumber: listingData.serialNumber
        });

        await updateDoc(listingRef, { state: "SOLD" });

        const confirmationMessage = `Delivery confirmed for "${listingData.assetName}". NFT transferred to ${listingData.buyerAccountId}.`;
        setMessages(prev => [...prev, { text: confirmationMessage }]);
        setScreenText("Delivery confirmed and NFT transferred.");

    } catch (error) {
        console.error("Error confirming delivery:", error);
        setScreenText(`Error: ${error.message}. Please try again.`);
    }
  };

  const processUssdInput = (input) => {
    const buyMatch = input.match(/^\*878\*4\*([a-zA-Z0-9]+)#$/);
    const confirmMatch = input.match(/^\*878\*5\*([a-zA-Z0-9]+)#$/);

    if (userAccount && buyMatch) {
      handleBuyAsset(buyMatch[1]); return;
    }
    if (userAccount && confirmMatch) {
      handleConfirmDelivery(confirmMatch[1]); return;
    }

    if (!userAccount) {
      if (currentMenu === 'home' && input === '*878*1#') {
        setCurrentMenu('create_account_name'); setScreenText('Enter your full name:'); return;
      }
      if (currentMenu === 'create_account_name') {
        setSessionData({ name: input }); setCurrentMenu('create_account_pin'); setScreenText('Enter a 4-digit PIN (for demo):'); return;
      }
      if (currentMenu === 'create_account_pin') {
        handleCreateAccount(); return;
      }
    }

    if (userAccount) {
       if (input === '*878*2#') {
         setCurrentMenu('list_asset_name'); setScreenText('Enter asset name:'); return;
       }
       if (currentMenu === 'list_asset_name') {
         setSessionData({ assetName: input }); setCurrentMenu('list_asset_price'); setScreenText('Enter price in HBAR:'); return;
       }
       if (currentMenu === 'list_asset_price') {
         setSessionData(prev => ({ ...prev, price: input })); handleMintAndList(); return;
       }
       if (input === '*878*3#') {
          handleViewMarketplace(); return;
       }
    }

    setScreenText(`Invalid input: ${input}.\nPlease hang up and try again.`);
  };

  const handleDialerSubmit = (e) => {
    e.preventDefault();
    processUssdInput(dialerInput);
    setDialerInput('');
  };

  return (
    <div style={{ border: '1px solid black', padding: '10px', width: '300px', backgroundColor: '#f5f5f5', fontFamily: 'monospace' }}>
      <div style={{ minHeight: '200px', border: '1px solid grey', marginBottom: '10px', padding: '5px', whiteSpace: 'pre-wrap', backgroundColor: '#90EE90', color: 'black' }}>
        {screenText}
      </div>
      <form onSubmit={handleDialerSubmit}>
        <input type="text" value={dialerInput} onChange={(e) => setDialerInput(e.target.value)} style={{ width: '100%', boxSizing: 'border-box', textAlign: 'center', fontFamily: 'monospace' }} placeholder="*878*1#" />
        <button type="submit" style={{ width: '100%', marginTop: '5px', backgroundColor: 'green', color: 'white' }}> Send </button>
      </form>
    </div>
  );
};

export default Phone;
