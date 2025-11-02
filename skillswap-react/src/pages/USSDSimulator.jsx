import React, { useState, useEffect } from 'react';
import './USSDSimulator.css';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { getFirestore, collection, onSnapshot, query, where, orderBy, doc, getDoc } from 'firebase/firestore';

const USSDSimulator = () => {
    const [inputValue, setInputValue] = useState('');
    const [screenText, setScreenText] = useState('Dial *878# to begin');
    const [currentMenu, setCurrentMenu] = useState('home');
    const [sessions, setSessions] = useState({}); // To manage multiple user sessions
    const [currentUser, setCurrentUser] = useState(null); // The currently active user
    const [smsInboxes, setSmsInboxes] = useState({});
    const [isLoading, setIsLoading] = useState(false);


    const functions = getFunctions();
    const db = getFirestore();

    const switchUser = (user) => {
        setCurrentUser(user);
        // Resetting the USSD state for the new user
        setScreenText('Dial *878# to begin');
        setCurrentMenu('home');
    };

    const handleButtonClick = (value) => {
        setInputValue(inputValue + value);
    };

    const handleClear = () => {
        setInputValue('');
    };

    const handleSend = async () => {
        const input = inputValue.trim();
        setInputValue('');

        if (!currentUser) {
            setScreenText("Please select a user to start.");
            return;
        }

        if (isLoading) return;

        const session = sessions[currentUser] || {};

        // Handle "Buy Now" and "Confirm Delivery" codes
        if (input.startsWith('*878*2*1*') && input.endsWith('#')) {
            const listingId = input.substring(9, input.length - 1);
            const listingRef = doc(db, "listings", listingId);
            const listingSnap = await getDoc(listingRef);
            if (listingSnap.exists()) {
                const listing = listingSnap.data();
                setSessions({
                    ...sessions,
                    [currentUser]: { ...session, purchase: { listingId, listing } }
                });
                setScreenText(`Buy '${listing.productName}' for ${listing.price} HBAR from ${listing.sellerAccountId}?\n1. Confirm\n2. Cancel`);
                setCurrentMenu('confirm_purchase');
            } else {
                setScreenText("Listing not found.");
            }
            return;
        }
        if (input.startsWith('*878*3*') && input.endsWith('*')) {
            const listingId = input.substring(7, input.length - 1);
            setSessions({
                ...sessions,
                [currentUser]: { ...session, purchase: { listingId } }
            });
            setScreenText(`Confirm delivery of 'Product' from 'Seller'?\n1. Confirm\n2. Cancel`);
            setCurrentMenu('confirm_delivery');
            return;
        }


        switch (currentMenu) {
            case 'home':
                if (input === '*878#') {
                    setScreenText('Welcome to Integro\n1. Create Vault\n2. My Vault\n3. View Marketplace');
                    setCurrentMenu('main');
                } else {
                    setScreenText('Invalid code. Dial *878# to begin');
                }
                break;

            case 'main':
                if (input === '1') {
                    setScreenText('Please create a 4-digit PIN for your Vault:');
                    setCurrentMenu('create_vault_pin');
                } else if (input === '2') {
                    if (!session.accountId) {
                        setScreenText('You must create a vault first.\n1. Create Vault');
                        setCurrentMenu('main');
                        return;
                    }
                    setScreenText('Enter your 4-digit PIN:');
                    setCurrentMenu('enter_pin_for_vault');
                } else if (input === '3') {
                    setScreenText('Marketplace\n1. Goods & Produce\n2. Services & Gigs');
                    setCurrentMenu('marketplace');
                } else {
                    setScreenText('Invalid selection. Please try again.');
                }
                break;

            case 'marketplace':
                if (input === '1') {
                    setIsLoading(true);
                    setScreenText('Your Request is Processing. You will receive an SMS shortly.');
                    // The useEffect hook will handle fetching and displaying the listings
                    setIsLoading(false);

                } else {
                    setScreenText('This feature is not yet implemented.');
                }
                break;

            case 'confirm_purchase':
                if (input === '1') {
                    setScreenText('Enter your 4-digit PIN to confirm purchase:');
                    setCurrentMenu('enter_pin_for_purchase');
                } else {
                    setScreenText('Purchase cancelled.');
                    setCurrentMenu('home');
                }
                break;

            case 'enter_pin_for_purchase':
                if (input === session.pin) {
                    setIsLoading(true);
                    setScreenText('Processing your purchase...');

                    try {
                        const fundEscrowUSSD = httpsCallable(functions, 'fundEscrowUSSD');
                        await fundEscrowUSSD({
                            buyerAccountId: session.accountId,
                            listingId: session.purchase.listingId,
                        });
                        setScreenText('Purchase successful!');

                        // Seller's SMS
                        const sellerInbox = smsInboxes[session.purchase.listing.sellerAccountId] || [];
                        setSmsInboxes({
                            ...smsInboxes,
                            [session.purchase.listing.sellerAccountId]: [...sellerInbox, {
                                body: `New Order! ${session.userName} purchased '${session.purchase.listing.productName}' for ${session.purchase.listing.price} HBAR.\nPlease arrange delivery.`,
                                timestamp: new Date().toLocaleTimeString()
                            }]
                        });

                        // Buyer's SMS
                        const buyerInbox = smsInboxes[currentUser] || [];
                        setSmsInboxes({
                            ...smsInboxes,
                            [currentUser]: [...buyerInbox, {
                                body: `Congratulations, you purchased '${session.purchase.listing.productName}' from ${session.purchase.listing.sellerAccountId}.\nTo confirm delivery, dial: *878*3*${session.purchase.listingId}*`,
                                timestamp: new Date().toLocaleTimeString()
                            }]
                        });

                    } catch (error) {
                        console.error("Error funding escrow:", error);
                        setScreenText(`Error: ${error.message}`);
                    } finally {
                        setIsLoading(false);
                        setCurrentMenu('home');
                    }
                } else {
                    setScreenText('Incorrect PIN. Purchase cancelled.');
                    setCurrentMenu('home');
                }
                break;

            case 'confirm_delivery':
                if (input === '1') {
                    setScreenText('Enter your 4-digit PIN to complete transaction:');
                    setCurrentMenu('enter_pin_for_delivery');
                } else {
                    setScreenText('Delivery confirmation cancelled.');
                    setCurrentMenu('home');
                }
                break;

            case 'enter_pin_for_delivery':
                if (input === session.pin) {
                    setIsLoading(true);
                    setScreenText('Processing delivery confirmation...');
                    try {
                        const confirmDeliveryUSSD = httpsCallable(functions, 'confirmDeliveryUSSD');
                        await confirmDeliveryUSSD({
                            buyerAccountId: session.accountId,
                            listingId: session.purchase.listingId,
                        });
                        setScreenText('Transaction complete! The seller has been paid. Thank you for using Integro.');
                    } catch (error) {
                        console.error("Error confirming delivery:", error);
                        setScreenText(`Error: ${error.message}`);
                    } finally {
                        setIsLoading(false);
                        setCurrentMenu('home');
                    }
                } else {
                    setScreenText('Incorrect PIN. Delivery confirmation cancelled.');
                    setCurrentMenu('home');
                }
                break;

            case 'enter_pin_for_vault':
                if (input === session.pin) {
                    setScreenText(`Welcome, ${session.userName}!\n1. List a Product\n2. View My Products\n3. Check Balance`);
                    setCurrentMenu('vault_menu');
                } else {
                    setScreenText('Incorrect PIN. Please try again:');
                }
                break;

            case 'vault_menu':
                if (input === '1') {
                    setScreenText('Enter Product Name:');
                    setCurrentMenu('list_product_name');
                } else {
                    setScreenText('This feature is not yet implemented.');
                }
                break;

            case 'list_product_name':
                setSessions({
                    ...sessions,
                    [currentUser]: { ...session, product: { ...session.product, name: input } }
                });
                setScreenText('Enter Price (in HBAR):');
                setCurrentMenu('list_product_price');
                break;

            case 'list_product_price':
                 setSessions({
                    ...sessions,
                    [currentUser]: { ...session, product: { ...session.product, price: input } }
                });
                setScreenText('Enter Description:');
                setCurrentMenu('list_product_description');
                break;

            case 'list_product_description':
                 setSessions({
                    ...sessions,
                    [currentUser]: { ...session, product: { ...session.product, description: input } }
                });
                setScreenText('Enter Location:');
                setCurrentMenu('list_product_location');
                break;

            case 'list_product_location':
                const product = { ...session.product, location: input };
                 setSessions({
                    ...sessions,
                    [currentUser]: { ...session, product }
                });
                setIsLoading(true);
                setScreenText('Listing your product...');

                try {
                    const listProductUSSD = httpsCallable(functions, 'listProductUSSD');
                    await listProductUSSD({
                        sellerAccountId: session.accountId,
                        productName: product.name,
                        price: product.price,
                        description: product.description,
                        location: product.location,
                    });
                    setScreenText(`Success! Your '${product.name}' is now listed on the Marketplace for ${product.price} HBAR.`);
                } catch (error) {
                    console.error("Error listing product:", error);
                    setScreenText(`Error: ${error.message}`);
                } finally {
                    setIsLoading(false);
                    setCurrentMenu('home');
                }
                break;

            case 'create_vault_pin':
                if (input.length === 4 && /^\d+$/.test(input)) {
                     setSessions({
                        ...sessions,
                        [currentUser]: { ...session, tempPin: input }
                    });
                    setScreenText('Please confirm your 4-digit PIN:');
                    setCurrentMenu('create_vault_confirm_pin');
                } else {
                    setScreenText('Invalid PIN. Please enter a 4-digit PIN:');
                }
                break;

            case 'create_vault_confirm_pin':
                if (input === session.tempPin) {
                    setScreenText('What is your name? (This will be shown to buyers/sellers):');
                    setCurrentMenu('create_vault_name');
                } else {
                    setScreenText('PINs do not match. Please create a 4-digit PIN for your Vault:');
                    setCurrentMenu('create_vault_pin');
                }
                break;

            case 'create_vault_name':
                 setSessions({
                    ...sessions,
                    [currentUser]: { ...session, tempName: input }
                });
                setIsLoading(true);
                setScreenText('Creating your vault...');

                try {
                    const createAccountUSSD = httpsCallable(functions, 'createAccountUSSD');
                    const result = await createAccountUSSD({ name: input, pin: session.tempPin });

                    const newSession = {
                        ...session,
                        userName: session.tempName,
                        accountId: result.data.accountId,
                        pin: session.tempPin,
                    };

                    setSessions({ ...sessions, [currentUser]: newSession });

                    setScreenText(`Congratulations, ${session.tempName}! Your Integro Vault is created. Account ID: ${result.data.accountId}. Dial *878# to begin.`);
                    setCurrentMenu('home');
                } catch (error) {
                    console.error("Error creating account:", error);
                    setScreenText(`Error: ${error.message}`);
                    setCurrentMenu('main');
                } finally {
                    setIsLoading(false);
                }
                break;

            default:
                setScreenText('Invalid selection. Please try again.');
                break;
        }
    };

    useEffect(() => {
        const q = query(collection(db, "listings"), where("state", "==", "LISTED"), orderBy("createdAt", "desc"));
        const unsubscribe = onSnapshot(q, (querySnapshot) => {
            let listingsSMS = '-- Integro Marketplace --\n';
            querySnapshot.forEach((doc) => {
                const listing = doc.data();
                const listingId = doc.id;
                listingsSMS += `${listing.productName} - ${listing.price} Hbar, ${listing.description}, sold by ${listing.sellerAccountId}\n`;
                listingsSMS += `Dial: *878*2*1*${listingId}#\n\n`;
            });

            if (currentUser) {
                setTimeout(() => {
                    const userInbox = smsInboxes[currentUser] || [];
                    setSmsInboxes({
                        ...smsInboxes,
                        [currentUser]: [...userInbox, { body: listingsSMS, timestamp: new Date().toLocaleTimeString() }]
                    });
                }, 2000);
            }
        });
        return unsubscribe;
    }, [db, currentUser]);


    return (
        <div className="ussd-simulator-container">
            <div className="user-switcher">
                <h3>Switch User</h3>
                <button onClick={() => { setCurrentUser('user1'); }}>User 1 (Tayo)</button>
                <button onClick={() => { setCurrentUser('user2'); }}>User 2 (Tunde)</button>
            </div>
            <div className="ussd-simulator">
                <div className="phone">
                    <div className="screen">
                        {isLoading ? <div className="loader"></div> : <pre>{screenText}</pre>}
                    </div>
                    <div className="dialer">
                        <input
                            type="text"
                            value={inputValue}
                            onChange={(e) => setInputValue(e.target.value)}
                            placeholder="Enter USSD code"
                            onKeyPress={(e) => e.key === 'Enter' && handleSend()}
                            disabled={isLoading}
                        />
                    </div>
                    <div className="keypad">
                        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((char) => (
                            <button key={char} onClick={() => handleButtonClick(char)} disabled={isLoading}>{char}</button>
                        ))}
                        <button onClick={handleClear} className="clear-button" disabled={isLoading}>Clear</button>
                        <button onClick={handleSend} className="send-button" disabled={isLoading}>Send</button>
                    </div>
                </div>
                <div className="sms-inbox">
                    <h2>SMS Inbox for {currentUser}</h2>
                    <div className="sms-messages">
                        {(smsInboxes[currentUser] || []).length === 0 ? (
                            <p>No messages</p>
                        ) : (
                            (smsInboxes[currentUser] || []).map((sms, index) => (
                                <div key={index} className="sms-message">
                                    <p>{sms.body}</p>
                                    <span className="sms-timestamp">{sms.timestamp}</span>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default USSDSimulator;
