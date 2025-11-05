import React, { useState, useEffect } from 'react';
import { httpsCallable } from 'firebase/functions';
import { functions, firestore } from './firebase-config'; // Import firestore
import { collection, query, onSnapshot, orderBy } from 'firebase/firestore';

// --- Main App Component ---
function App() {
  // --- STATE ---
  const [menuState, setMenuState] = useState('main');
  const [screenText, setScreenText] = useState("Welcome.\n1. Create Vault");
  const [user, setUser] = useState(null); // Will hold { accountId, privateKey }
  const [tempData, setTempData] = useState({}); // For multi-step forms
  const [smsInbox, setSmsInbox] = useState([]); // For real-time SMS
  const [marketplaceListings, setMarketplaceListings] = useState([]);

  // --- REAL-TIME SMS LISTENER ---
  useEffect(() => {
    if (!user) return; // Don't listen until user is created
    // Listen to this user's specific SMS inbox in Firestore
    const q = query(
      collection(firestore, 'sms_inbox', user.accountId, 'messages'),
      orderBy('timestamp', 'desc')
    );
    const unsubscribe = onSnapshot(q, (querySnapshot) => {
      const messages = querySnapshot.docs.map(doc => doc.data().message);
      setSmsInbox(messages);
    });
    return () => unsubscribe(); // Cleanup listener on unmount
  }, [user]); // Re-run this effect when the user logs in

  // --- Marketplace Listener ---
  useEffect(() => {
    const q = query(collection(firestore, "listings"), orderBy("createdAt", "desc"));
    const unsubscribe = onSnapshot(q, (querySnapshot) => {
      const listings = [];
      querySnapshot.forEach((doc) => {
        listings.push({
          id: doc.id,
          ...doc.data()
        });
      });
      setMarketplaceListings(listings);
    });
    return () => unsubscribe();
  }, []);


  // --- Main Input Handler ---
  const handleInput = async (input) => {
    try {
      // --- Flow 1: Create Vault (State: 'main') ---
      if (menuState === 'main' && input === '1') {
        setMenuState('create_name');
        setScreenText("Enter your full name:");
      } else if (menuState === 'create_name') {
        setTempData({
          name: input
        });
        setMenuState('create_pin');
        setScreenText("Create a 4-digit PIN:");
      } else if (menuState === 'create_pin') {
        setScreenText("Processing... Please wait.");
        // 1. Create the vault
        const createVault = httpsCallable(functions, 'createVault_ussd');
        const vaultData = await createVault();
        const newAccountId = vaultData.data.accountId;
        const newPrivateKey = vaultData.data.privateKey;
        // 2. Set the profile
        const setUserProfile = httpsCallable(functions, 'setUserProfile');
        await setUserProfile({
          accountId: newAccountId,
          displayName: tempData.name,
          role: "User",
          location: "Demo Location"
        });
        // 3. Set the user state, which triggers the SMS listener
        setUser({
          accountId: newAccountId,
          privateKey: newPrivateKey
        });
        setMenuState('logged_in');
        setScreenText(`Vault Created! Welcome, ${tempData.name}.\n\n1. List New Product\n2. View Marketplace`);
      } else if (menuState === 'logged_in' && input === '1') {
        setMenuState('list_product_name');
        setScreenText("Enter product name:");
      } else if (menuState === 'list_product_name') {
        setTempData({ ...tempData,
          productName: input
        });
        setMenuState('list_price');
        setScreenText("Enter price in HBAR:");
      } else if (menuState === 'list_price') {
        setTempData({ ...tempData,
          price: input
        });
        setMenuState('list_description');
        setScreenText("Enter product description:");
      } else if (menuState === 'list_description') {
        setTempData({ ...tempData,
          description: input
        });
        setMenuState('list_location');
        setScreenText("Enter your location:");
      } else if (menuState === 'list_location') {
        setScreenText("Listing product... Please wait.");
        const listProduct = httpsCallable(functions, 'listProduct_ussd');
        await listProduct({
          sellerAccountId: user.accountId,
          sellerPrivateKey: user.privateKey,
          productName: tempData.productName,
          price: tempData.price,
          description: tempData.description,
          location: input
        });
        setMenuState('logged_in');
        setScreenText(`Product listed successfully!\n\n1. List New Product\n2. View Marketplace`);
      } else if (menuState === 'logged_in' && input === '2') {
        let marketplaceText = "Marketplace:\n";
        marketplaceListings.forEach((listing, index) => {
          marketplaceText += `${index + 1}. ${listing.productName} - ${listing.price} HBAR\n`;
        });
        marketplaceText += "\nEnter the number of the product you want to buy.";
        setScreenText(marketplaceText);
        setMenuState('marketplace_selection');
      } else if (menuState === 'marketplace_selection') {
        const selection = parseInt(input) - 1;
        if (selection >= 0 && selection < marketplaceListings.length) {
          const listing = marketplaceListings[selection];
          setTempData({
            listing
          });
          setScreenText(`You selected: ${listing.productName}\nPrice: ${listing.price} HBAR\n\n1. Confirm Purchase`);
          setMenuState('confirm_purchase');
        } else {
          setScreenText("Invalid selection. Please try again.");
        }
      } else if (menuState === 'confirm_purchase' && input === '1') {
        setScreenText("Processing purchase... Please wait.");
        const fundEscrow = httpsCallable(functions, 'fundEscrow_ussd');
        await fundEscrow({
          buyerAccountId: user.accountId,
          buyerPrivateKey: user.privateKey,
          listingId: tempData.listing.id,
          amount: tempData.listing.price
        });
        setMenuState('logged_in');
        setScreenText(`Purchase successful!\n\n1. List New Product\n2. View Marketplace\n3. Confirm Delivery`);
      } else if (menuState === 'logged_in' && input === '3') {
        setMenuState('confirm_delivery');
        let purchasesText = "Your Purchases:\n";
        const myPurchases = marketplaceListings.filter(listing => listing.buyerAccountId === user.accountId && listing.state === "FUNDED");
        myPurchases.forEach((listing, index) => {
          purchasesText += `${index + 1}. ${listing.productName}\n`;
        });
        purchasesText += "\nEnter the number of the product you want to confirm delivery for.";
        setScreenText(purchasesText);
        setTempData({myPurchases});
      } else if (menuState === 'confirm_delivery') {
        const selection = parseInt(input) - 1;
        if (selection >= 0 && selection < tempData.myPurchases.length) {
          const listing = tempData.myPurchases[selection];
          setScreenText("Confirming delivery... Please wait.");
          const confirmDelivery = httpsCallable(functions, 'confirmDelivery_ussd');
          await confirmDelivery({
            buyerAccountId: user.accountId,
            buyerPrivateKey: user.privateKey,
            listingId: listing.id
          });
          setMenuState('logged_in');
          setScreenText(`Delivery confirmed!\n\n1. List New Product\n2. View Marketplace`);
        } else {
          setScreenText("Invalid selection. Please try again.");
        }
      }

    } catch (error) {
      setMenuState('main'); // Reset on error
      setScreenText(`Error: ${error.message}\n\n1. Create Vault`);
    }
  };

  // --- JSX RENDER ---
  return (
    <div className="phone-simulator-container" style={{ padding: '20px', fontFamily: 'Arial, sans-serif' }}>
      <h1>Integro USSD Simulator</h1>
      <p>Account: {user ? user.accountId : "None"}</p>
      {/* Phone Screen */}
      <pre style={{ background: '#eee', padding: '10px', minHeight: '150px' }}>{screenText}</pre>
      {/* Dialer */}
      <input
        type="text"
        placeholder="Dial..."
        style={{ width: '100%' }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            handleInput(e.target.value);
            e.target.value = ""; // Clear input
          }
        }}
      />
      {/* Real-Time SMS Inbox */}
      <div className="sms-inbox" style={{ marginTop: '20px' }}>
        <h3>Real-Time SMS Inbox:</h3>
        <div style={{ background: '#eee', padding: '10px', minHeight: '100px' }}>
          {smsInbox.length === 0 ? "(No messages)" :
            smsInbox.map((msg, i) => <pre key={i}>{msg}</pre>)}
        </div>
      </div>
    </div>
  );
}
export default App;
