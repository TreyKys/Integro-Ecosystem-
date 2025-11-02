import React, { useState, useEffect } from 'react';
import { collection, getDocs } from "firebase/firestore";
import { db } from '../firebase';
import './USSDSimulator.css';
import { getFunctions, httpsCallable } from 'firebase/functions';

const USSDSimulator = () => {
    const [screenText, setScreenText] = useState('Dial *878# to begin');
    const [inputValue, setInputValue] = useState('');
    const [menuState, setMenuState] = useState('home');
    const [smsMessages, setSmsMessages] = useState([]);
    const [users, setUsers] = useState([]);
    const [currentUserIndex, setCurrentUserIndex] = useState(null);
    const [tempSession, setTempSession] = useState({});

    const functions = getFunctions();
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

    const handleSend = async () => {
        let newMenuState = menuState;

        if (!currentUser && menuState !== 'main_menu' && inputValue !== '*878#') {
            setScreenText('Create a user vault to start.');
            setInputValue('');
            return;
        }

        // USSD Code routing first
        if (menuState === 'home' && inputValue.startsWith('*878*')) {
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
                     else if (inputValue === '2') { newMenuState = 'enter_pin_for_vault'; setScreenText('Enter your PIN:'); }
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
                    setScreenText('Creating vault...');
                    try {
                        const createAccountFromUSSD = httpsCallable(functions, 'createAccountFromUSSD');
                        const result = await createAccountFromUSSD({ name: inputValue, pin: tempSession.pin });
                        const data = result.data;
                        const newUser = { name: inputValue, pin: tempSession.pin, ...data };
                        const updatedUsers = [...users, newUser];
                        setUsers(updatedUsers);
                        setCurrentUserIndex(updatedUsers.length - 1);
                        setScreenText(`Vault for ${newUser.name} created! Account ID: ${newUser.accountId}`);
                        newMenuState = 'home';
                    } catch(e) {
                        setScreenText('Error creating vault.');
                    }
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
                        const listProductFromUSSD = httpsCallable(functions, 'listProductFromUSSD');
                        await listProductFromUSSD({
                            sellerAccountId: currentUser.accountId,
                            productName: tempSession.productName,
                            price: tempSession.price,
                            description: tempSession.description,
                            location: inputValue,
                        });
                        setScreenText('Product listed successfully!');
                    } catch(e) {
                        setScreenText('Error listing product.');
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
                            const price = p.price ? `${p.price} Hbar` : "N/A";
                            smsContent += `${p.productName} - ${price}\nDial: *878*2*1*${p.id}#\n\n`;
                        });
                        setSmsMessages([...smsMessages, { sender: 'Marketplace', content: smsContent, recipient: currentUser.accountId }]);
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
                            const fundEscrowFromUSSD = httpsCallable(functions, 'fundEscrowFromUSSD');
                            await fundEscrowFromUSSD({
                                buyerAccountId: currentUser.accountId,
                                listingId: tempSession.selectedListing.id,
                            });

                            const sellerMsg = `New Order! ${currentUser.name} purchased '${tempSession.selectedListing.productName}'.`;
                            const buyerMsg = `You purchased '${tempSession.selectedListing.productName}'. To confirm delivery, dial: *878*3*${tempSession.selectedListing.id}#`;
                            setSmsMessages(prev => [...prev, { sender: 'Integro', content: sellerMsg, recipient: tempSession.selectedListing.sellerAccountId }]);
                            setSmsMessages(prev => [...prev, { sender: 'Integro', content: buyerMsg, recipient: currentUser.accountId }]);
                            setScreenText('Purchase successful!');
                        } catch(e) {
                            setScreenText('Purchase failed.');
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
                            const confirmDeliveryFromUSSD = httpsCallable(functions, 'confirmDeliveryFromUSSD');
                             await confirmDeliveryFromUSSD({
                                buyerAccountId: currentUser.accountId,
                                listingId: tempSession.deliveryListingId
                            });
                            setScreenText('Delivery confirmed! Seller has been paid.');
                        } catch(e) {
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
                        {user.name} ({user.accountId.slice(-4)})
                    </button>
                ))}
                 <button onClick={() => { setMenuState('main_menu'); setInputValue('1'); handleSend(); }} className="new-user-btn">+ New User</button>
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
