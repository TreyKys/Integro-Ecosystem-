import React, { useState, useEffect } from 'react';
import { PrivateKey } from "@hashgraph/sdk";
import { collection, getDocs } from "firebase/firestore";
import { db } from '../firebase';
import './USSDSimulator.css';

// It's better to manage these via environment variables, but for the simulator, this is okay.
const CREATE_ACCOUNT_URL = "https://createaccount-cehqwvb4aq-uc.a.run.app";
const LIST_PRODUCT_URL = "https://listproductfromussd-cehqwvb4aq-uc.a.run.app";
const FUND_ESCROW_URL = "https://fundescrowfromussd-cehqwvb4aq-uc.a.run.app";
const CONFIRM_DELIVERY_URL = "https://confirmdeliveryfromussd-cehqwvb4aq-uc.a.run.app";

const USSDSimulator = () => {
    const [screenText, setScreenText] = useState('Dial *878# to begin');
    const [inputValue, setInputValue] = useState('');
    const [menuState, setMenuState] = useState('home');
    const [smsMessages, setSmsMessages] = useState([]);
    const [users, setUsers] = useState([]);
    const [currentUserIndex, setCurrentUserIndex] = useState(null);
    const [tempSession, setTempSession] = useState({});

    useEffect(() => {
        const savedUsers = localStorage.getItem("ussd-vaults");
        if (savedUsers) {
            const parsedUsers = JSON.parse(savedUsers);
            setUsers(parsedUsers);
            if (parsedUsers.length > 0) {
                // Optional: auto-select the first user
                // setCurrentUserIndex(0);
            }
        }
    }, []);

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

    async function createVaultViaUSSD() {
        try {
            const newKey = PrivateKey.generateECDSA();
            const privateKeyStr = newKey.toString();
            const publicKeyStr = newKey.publicKey.toString();

            setScreenText('Creating vault...');
            const resp = await fetch(CREATE_ACCOUNT_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ publicKey: publicKeyStr }),
            });

            if (!resp.ok) {
                const errText = await resp.text();
                throw new Error("createAccount failed: " + errText);
            }

            const data = await resp.json();
            if (!data.accountId) {
                throw new Error("createAccount did not return accountId");
            }

            const newUser = {
                ...tempSession,
                accountId: data.accountId,
                privateKey: privateKeyStr,
            };

            const updatedUsers = [...users, newUser];
            setUsers(updatedUsers);
            localStorage.setItem("ussd-vaults", JSON.stringify(updatedUsers));
            setCurrentUserIndex(updatedUsers.length - 1);

            setScreenText(`Vault for ${newUser.name} created! Account ID: ${newUser.accountId}`);
            return true;
        } catch (err) {
            console.error("USSD createVault error", err);
            setScreenText("Error creating vault: " + err.message);
            return false;
        }
    }

    const handleSend = async () => {
        let newMenuState = menuState;

        const actionRequiresVault = () => {
            const vaultlessStates = ['home', 'main_menu', 'create_pin', 'confirm_pin', 'enter_name'];
            if (vaultlessStates.includes(menuState)) {
                 if(menuState === 'main_menu' && inputValue === '1') return false; // allow vault creation
                 if(menuState === 'home' && inputValue === '*878#') return false; // allow dialing in
                 if(vaultlessStates.includes(menuState) && menuState !== 'home' && menuState !== 'main_menu') return false;
            }

            if (!currentUser) {
                setScreenText('Please create or select a user vault to perform this action.');
                setInputValue('');
                return true;
            }
            return false;
        };

        if (actionRequiresVault()) return;


        if (menuState === 'home' && inputValue.startsWith('*878*')) {
            if (!currentUser) { // Double check for direct dialing
                 setScreenText('Please create or select a user vault first.'); setInputValue(''); return;
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
                     if (inputValue === '1') { newMenuState = 'create_pin'; setScreenText('Create a 4-digit PIN:'); }
                     else if (inputValue === '2') {
                        if (users.length === 0) { setScreenText('No vault found. Please create one.'); break; }
                        if (!currentUser) {setScreenText('Please select a user first.'); break; }
                        newMenuState = 'enter_pin_for_vault'; setScreenText('Enter your PIN:');
                    }
                     else if (inputValue === '3') { newMenuState = 'marketplace_menu'; setScreenText('Marketplace\n1. Goods & Produce');}
                    break;
                case 'create_pin':
                    setTempSession({ pin: inputValue });
                    newMenuState = 'confirm_pin';
                    setScreenText('Confirm PIN:');
                    break;
                case 'confirm_pin':
                    if (inputValue === tempSession.pin) {
                        newMenuState = 'enter_name';
                        setScreenText('Enter your name:');
                    } else {
                        newMenuState = 'create_pin';
                        setScreenText('PINs do not match. Try again:');
                    }
                    break;
                case 'enter_name':
                    setTempSession({ ...tempSession, name: inputValue });
                    const success = await createVaultViaUSSD();
                    newMenuState = success ? 'home' : 'main_menu';
                    break;
                case 'enter_pin_for_vault':
                    if (inputValue === currentUser.pin) {
                        setScreenText(`Welcome ${currentUser.name}\n1. List Product\n2. My Products\n3. Balance`);
                        newMenuState = 'vault_menu';
                    } else {
                        setScreenText('Incorrect PIN.');
                    }
                    break;
                case 'vault_menu':
                    if(inputValue === '1') { newMenuState = 'list_product_name'; setScreenText('Product Name:'); }
                    break;
                case 'list_product_name':
                    setTempSession({...tempSession, productName: inputValue});
                    newMenuState = 'list_product_price';
                    setScreenText('Price (HBAR):');
                    break;
                case 'list_product_price':
                    setTempSession({...tempSession, price: inputValue});
                    newMenuState = 'list_product_desc';
                    setScreenText('Description:');
                    break;
                case 'list_product_desc':
                    setTempSession({...tempSession, description: inputValue});
                    newMenuState = 'list_product_loc';
                    setScreenText('Location:');
                    break;
                case 'list_product_loc':
                     setScreenText('Listing product...');
                    try {
                        const payload = {
                            sellerAccountId: currentUser.accountId,
                            sellerPrivateKey: currentUser.privateKey,
                            productName: tempSession.productName,
                            price: parseFloat(tempSession.price),
                            description: tempSession.description,
                            location: inputValue,
                        };
                        const response = await fetch(LIST_PRODUCT_URL, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload) });
                        if(!response.ok) {
                            const errText = await response.text();
                            throw new Error(errText || "Failed to list product");
                        }
                        setScreenText('Product listed successfully!');
                    } catch(e) {
                        setScreenText(`Error listing product: ${e.message}`);
                    }
                    newMenuState = 'home';
                    break;
                case 'marketplace_menu':
                    if(inputValue === '1') {
                        setScreenText('Fetching listings... SMS incoming.');
                        const listingsCol = collection(db, "listings");
                        const snapshot = await getDocs(listingsCol);
                        const listings = snapshotToArray(snapshot);
                        let smsContent = "-- Integro Marketplace --\n";
                        listings.forEach(p => {
                            smsContent += `${p.productName} - ${p.price} Hbar\nDial: *878*2*1*${p.id}#\n\n`;
                        });
                        setSmsMessages([...smsMessages, { sender: 'Marketplace', content: smsContent, recipient: currentUser?.accountId }]);
                        newMenuState = 'home';
                    }
                    break;
                case 'confirm_purchase':
                    if(inputValue === '1') { newMenuState = 'purchase_pin'; setScreenText('Enter PIN to confirm purchase:');}
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
                                amount: parseFloat(tempSession.selectedListing.price)
                            };
                            const response = await fetch(FUND_ESCROW_URL, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload) });
                             if(!response.ok) {
                                const errText = await response.text();
                                throw new Error(errText || 'Purchase failed');
                            }

                            const sellerMsg = `New Order! ${currentUser.name} purchased '${tempSession.selectedListing.productName}'.`;
                            const buyerMsg = `You purchased '${tempSession.selectedListing.productName}'. To confirm delivery, dial: *878*3*${tempSession.selectedListing.id}#`;
                            setSmsMessages(prev => [...prev, { sender: 'Integro', content: sellerMsg, recipient: tempSession.selectedListing.sellerAccountId }]);
                            setSmsMessages(prev => [...prev, { sender: 'Integro', content: buyerMsg, recipient: currentUser.accountId }]);
                            setScreenText('Purchase successful!');
                        } catch(e) {
                            setScreenText(`Purchase failed: ${e.message}`);
                        }
                    } else {
                        setScreenText('Incorrect PIN.');
                    }
                    newMenuState = 'home';
                    break;
                 case 'confirm_delivery':
                    if(inputValue === '1') { newMenuState = 'delivery_pin'; setScreenText('Enter PIN to confirm delivery:');}
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
                            if(!response.ok) {
                                const errText = await response.text();
                                throw new Error(errText || 'Confirmation failed');
                            }
                            setScreenText('Delivery confirmed! Seller has been paid.');
                        } catch(e) {
                             setScreenText(`Confirmation failed: ${e.message}`);
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
                 <button onClick={() => { setInputValue('1'); setMenuState('main_menu'); handleSend(); }} className="new-user-btn">+ New User</button>
            </div>
            <div className="ussd-simulator">
                <div className="phone-screen"><pre>{screenText}</pre></div>
                <div className="dialer-input-container">
                    <input type="text" value={inputValue} onChange={(e) => setInputValue(e.target.value)} />
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
                    {smsMessages.filter(msg => !msg.recipient || msg.recipient === currentUser?.accountId).map((message, index) => (
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
