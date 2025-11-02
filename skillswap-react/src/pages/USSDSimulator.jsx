import React, { useState, useEffect, useRef } from 'react';
import { collection, getDocs, addDoc, serverTimestamp, query, where, onSnapshot, orderBy } from "firebase/firestore";
import { db } from '../firebase';
import './USSDSimulator.css';

// It's better to manage these via environment variables, but for the simulator, this is okay.
const CREATE_ACCOUNT_URL = "https://createaccount-cehqwvb4aq-uc.a.run.app";
const LIST_PRODUCT_URL = "https://listproductfromussd-cehqwvb4aq-uc.a.run.app";
const FUND_ESCROW_URL = "https://fundescrowfromussd-cehqwvb4aq-uc.a.run.app";
const CONFIRM_DELIVERY_URL = "https://us-central1-integro-ecosystem.cloudfunctions.net/confirmDeliveryFromUSSD";

const USSDSimulator = () => {
    const [screenText, setScreenText] = useState('Dial *878# to begin');
    const [inputValue, setInputValue] = useState('');
    const [menuState, setMenuState] = useState('home');
    const [smsMessages, setSmsMessages] = useState([]);
    const [users, setUsers] = useState([]);
    const [currentUserIndex, setCurrentUserIndex] = useState(null);
    const [tempSession, setTempSession] = useState({});
    const inputRef = useRef(null);

    useEffect(() => {
        if (inputRef.current) {
            inputRef.current.focus();
        }
    }, []);

    useEffect(() => {
        // Clear messages immediately when user changes to prevent rendering stale data
        setSmsMessages([]);

        if (currentUser && currentUser.accountId) {
            const q = query(
                collection(db, "sms_inbox"),
                where("recipient", "==", currentUser.accountId),
                orderBy("createdAt", "desc")
            );

            const unsubscribe = onSnapshot(q, (querySnapshot) => {
                const messages = [];
                querySnapshot.forEach((doc) => {
                    messages.push({ id: doc.id, ...doc.data() });
                });
                setSmsMessages(messages);
            });

            // Cleanup subscription on component unmount or when currentUser changes
            return () => unsubscribe();
        }
    }, [currentUser]);

    const handleKeyDown = (event) => {
        if (event.key === 'Enter') {
            handleSend();
        }
    };

    const currentUser = currentUserIndex !== null ? users[currentUserIndex] : null;

    const snapshotToArray = (snapshot) => {
        const array = [];
        snapshot.forEach((doc) => array.push({ id: doc.id, ...doc.data() }));
        return array;
    };

    const handleInput = (value) => setInputValue(inputValue + value);
    const handleClear = () => setInputValue('');

    const switchUser = (index) => {
        setCurrentUserIndex(index);
        setMenuState('home');
        setScreenText(`Switched to User #${index + 1}'s phone.\nDial *878# to begin.`);
    };

    const handleInitiateNewUser = () => {
        setMenuState('create_pin');
        setScreenText('Please create a 4-digit PIN for your Vault:');
        setInputValue('');
    };

    const handleSend = async () => {
        let newMenuState = menuState;

        // USSD Code routing first
        if (menuState === 'home' && inputValue.startsWith('*878*')) {
            if (!currentUser) {
                setScreenText('Create a user vault to start.');
                setInputValue('');
                return;
            }

            if (inputValue.startsWith('*878*2*1*')) {
                const listingId = inputValue.split('*')[4].replace('#', '');
                const listingsCol = collection(db, "listings");
                const snapshot = await getDocs(listingsCol);
                const listing = snapshotToArray(snapshot).find(l => l.id === listingId);

                if (listing) {
                    setTempSession({ selectedListing: listing });
                    setScreenText(`Buy '${listing.productName}' for ${listing.price} HBAR?\n1. Confirm\n2. Cancel`);
                    newMenuState = 'confirm_purchase';
                } else {
                    setScreenText('Invalid listing code.');
                }
            } else if (inputValue.startsWith('*878*3*')) {
                const listingId = inputValue.split('*')[3].replace('#', '');
                setTempSession({ ...tempSession, deliveryListingId: listingId });
                setScreenText(`Confirm delivery for listing ${listingId}?\n1. Confirm\n2. Cancel`);
                newMenuState = 'confirm_delivery';
            }
        } else {
            switch (menuState) {
                case 'home':
                    if (inputValue === '*878#') {
                        setScreenText(`Welcome to Integro\n1. Create Vault\n2. My Vault\n3. View Marketplace`);
                        newMenuState = 'main_menu';
                    }
                    break;
                case 'main_menu':
                     if (inputValue === '1') {
                         newMenuState = 'create_pin'; setScreenText('Please create a 4-digit PIN for your Vault:');
                     } else if (inputValue === '2') {
                         if (!currentUser) {
                            setScreenText('Please create a vault first.');
                            newMenuState = 'main_menu';
                         } else {
                            newMenuState = 'enter_pin_for_vault'; setScreenText('Enter your PIN:');
                         }
                     } else if (inputValue === '3') {
                        if (!currentUser) {
                            setScreenText('Please create a vault first.');
                            newMenuState = 'main_menu';
                        } else {
                            newMenuState = 'marketplace_menu'; setScreenText('Marketplace\n1. Goods & Produce');
                        }
                     }
                    break;
                case 'create_pin':
                    setTempSession({ pin: inputValue });
                    newMenuState = 'confirm_pin';
                    setScreenText('Please confirm your 4-digit PIN:');
                    break;
                case 'confirm_pin':
                    if (inputValue === tempSession.pin) {
                        newMenuState = 'enter_name';
                        setScreenText('What is your name? (This will be shown to buyers/sellers):');
                    } else {
                        newMenuState = 'create_pin';
                        setScreenText('PINs do not match. Try again:');
                    }
                    break;
                case 'enter_name':
                    setTempSession({ ...tempSession, name: inputValue });
                    setScreenText('Creating vault...');
                    try {
                        const response = await fetch(CREATE_ACCOUNT_URL, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ name: inputValue }) // Pass the name to the backend
                        });
                        if(!response.ok) throw new Error("Failed to create account");
                        const data = await response.json();
                        const newUser = { ...tempSession, ...data, name: inputValue };
                        const updatedUsers = [...users, newUser];
                        setUsers(updatedUsers);
                        setCurrentUserIndex(updatedUsers.length - 1);
                        setScreenText(`Congratulations, ${newUser.name}! Your Integro Vault is created. Account ID: ${newUser.accountId}. Dial *878# to begin.`);
                        newMenuState = 'home';
                    } catch(e) {
                        console.error(e);
                        setScreenText('Error creating vault. Please try again.');
                    }
                    break;
                case 'enter_pin_for_vault':
                    if (inputValue === currentUser.pin) {
                        setScreenText(`Welcome ${currentUser.name}\n1. List a Product\n2. View My Products\n3. Check Balance`);
                        newMenuState = 'vault_menu';
                    } else {
                        setScreenText('Incorrect PIN.');
                    }
                    break;
                case 'vault_menu':
                    if(inputValue === '1') { newMenuState = 'list_product_name'; setScreenText('Enter Product Name:'); }
                    break;
                case 'list_product_name':
                    setTempSession({...tempSession, productName: inputValue});
                    newMenuState = 'list_product_price';
                    setScreenText('Enter Price (in HBAR):');
                    break;
                case 'list_product_price':
                    setTempSession({...tempSession, price: inputValue});
                    newMenuState = 'list_product_desc';
                    setScreenText('Enter Description:');
                    break;
                case 'list_product_desc':
                    setTempSession({...tempSession, description: inputValue});
                    newMenuState = 'list_product_loc';
                    setScreenText('Enter Location:');
                    break;
                case 'list_product_loc':
                     setScreenText('Listing product...');
                    try {
                        const payload = {
                            sellerAccountId: currentUser.accountId,
                            sellerPrivateKey: currentUser.privateKey,
                            productName: tempSession.productName,
                            price: tempSession.price,
                            description: tempSession.description,
                            location: inputValue,
                        };
                        const response = await fetch(LIST_PRODUCT_URL, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload) });
                        if(!response.ok) throw new Error("Failed to list product");
                        setScreenText(`Success! Your '${tempSession.productName}' are now listed on the Marketplace for ${tempSession.price} HBAR.`);
                    } catch(e) {
                        console.error(e);
                        setScreenText('Error listing product.');
                    }
                    newMenuState = 'home';
                    break;
                case 'marketplace_menu':
                     if (inputValue === '1') {
                        setScreenText('Your Request is Processing. You will receive an SMS shortly.');
                        const listingsCol = collection(db, "listings");
                        const snapshot = await getDocs(listingsCol);
                        const listings = snapshotToArray(snapshot);
                        let smsContent = "-- Integro Marketplace --\n";
                        listings.forEach((p, i) => {
                            // Using a simplified index-based code for now, will map to listingId later
                            const dialCode = `*878*2*1*${p.id}#`;
                            smsContent += `${p.productName} - ${p.price} Hbar, sold by ${p.sellerName || 'Tunde'}\nDial: ${dialCode}\n\n`;
                        });
                        setTimeout(async () => {
                            await addDoc(collection(db, "sms_inbox"), {
                                sender: 'Marketplace',
                                content: smsContent,
                                recipient: currentUser.accountId,
                                createdAt: serverTimestamp()
                            });
                        }, 2000);
                        newMenuState = 'home';
                    }
                    break;
                case 'confirm_purchase':
                     if(inputValue === '1') { newMenuState = 'purchase_pin'; setScreenText(`Enter your 4-digit PIN to confirm purchase:` );}
                    else { newMenuState = 'home'; setScreenText('Purchase canceled.'); }
                    break;
                case 'purchase_pin':
                    if (inputValue === currentUser.pin) {
                        setScreenText('Processing purchase...');
                        try {
                            const payload = {
                                buyerAccountId: currentUser.accountId,
                                buyerPrivateKey: currentUser.privateKey,
                                listingId: tempSession.selectedListing.id,
                                amount: tempSession.selectedListing.price
                            };
                            const response = await fetch(FUND_ESCROW_URL, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload) });
                            if(!response.ok) throw new Error('Purchase failed');

                            const sellerMsg = `New Order! ${currentUser.name} purchased '${tempSession.selectedListing.productName}' for ${tempSession.selectedListing.price} HBAR. Please arrange delivery.`;
                            const buyerMsg = `Congratulations, you purchased '${tempSession.selectedListing.productName}' from ${tempSession.selectedListing.sellerName || 'Tunde'}. To confirm delivery, dial: *878*3*${tempSession.selectedListing.id}#`;

                            // Find the seller to send them the SMS
                            const seller = users.find(u => u.accountId === tempSession.selectedListing.sellerAccountId);

                            // Persist SMS messages to Firestore
                            await addDoc(collection(db, "sms_inbox"), {
                                sender: 'Integro',
                                content: sellerMsg,
                                recipient: seller ? seller.accountId : null,
                                createdAt: serverTimestamp()
                            });

                            await addDoc(collection(db, "sms_inbox"), {
                                sender: 'Integro',
                                content: buyerMsg,
                                recipient: currentUser.accountId,
                                createdAt: serverTimestamp()
                            });

                            setScreenText('Transaction complete! Tunde has been paid. Thank you for using Integro.');
                        } catch(e) {
                            console.error(e);
                            setScreenText('Purchase failed.');
                        }
                    } else {
                        setScreenText('Incorrect PIN.');
                    }
                    newMenuState = 'home';
                    break;
                 case 'confirm_delivery':
                    if(inputValue === '1') { newMenuState = 'delivery_pin'; setScreenText('Enter your 4-digit PIN to complete transaction:');}
                    else { newMenuState = 'home'; setScreenText('Confirmation canceled.'); }
                    break;
                case 'delivery_pin':
                    if (inputValue === currentUser.pin) {
                        setScreenText('Confirming delivery...');
                        try {
                             const payload = {
                                buyerAccountId: currentUser.accountId,
                                buyerPrivateKey: currentUser.privateKey,
                                listingId: tempSession.deliveryListingId
                            };
                            const response = await fetch(CONFIRM_DELIVERY_URL, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload) });
                            if(!response.ok) throw new Error('Confirmation failed');
                            setScreenText('Delivery confirmed! Seller has been paid.');
                        } catch(e) {
                             console.error(e);
                             setScreenText('Confirmation failed.');
                        }
                    } else {
                         setScreenText('Incorrect PIN.');
                    }
                    newMenuState = 'home';
                    break;
                default:
                    setScreenText('Invalid selection.');
                    newMenuState = 'home';
            }
        }
        setMenuState(newMenuState);
        setInputValue('');
    };

    return (
         <div className="ussd-simulator-container">
            <div className="user-switcher">
                <h3>Simulated Phones</h3>
                {users.map((user, index) => (
                    <button
                        key={index}
                        onClick={() => switchUser(index)}
                        className={currentUserIndex === index ? 'active' : ''}
                    >
                        {user.name} ({user.accountId ? user.accountId.slice(-4) : '...'})
                    </button>
                ))}
                 <button onClick={handleInitiateNewUser} className="new-user-btn">+ New User</button>
            </div>
            <div className="ussd-simulator">
                <div className="phone-screen"><pre>{screenText}</pre></div>
                <div className="dialer-input-container">
                    <input
                        type="text"
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        ref={inputRef}
                        onKeyDown={handleKeyDown}
                    />
                </div>
                <div className="keypad">
                    {'123456789*0#'.split('').map(char => <button key={char} onClick={() => handleInput(char)}>{char}</button>)}
                    <button className="send-btn" onClick={handleSend}>Send</button>
                    <button className="clear-btn" onClick={handleClear}>Clear</button>
                </div>
            </div>
            <div className="sms-inbox-container">
                <h2>SMS Inbox {currentUser ? `for ${currentUser.name}` : ''}</h2>
                <div className="sms-inbox">
                    {smsMessages.map((message, index) => (
                        <div key={index} className="sms-message">
                            <p className="sms-sender">{message.sender}</p>
                            <p className="sms-content">{message.content}</p>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};

export default USSDSimulator;
