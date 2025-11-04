import React, { useState } from 'react';
import { handleList, handleBuy, confirmDelivery } from '../hedera_helpers';
import { collection, query, where, getDocs } from '../firebase';
import './UssdDemoPage.css';

// --- Hardcoded Credentials ---
const tundeAccountId = '0.0.7181564';
const tundePrivateKey = '302e020100300506032b657004220420714f54ea3b88302809671a45e079cda165206e1ff9aace67a9fd5621febcf4c2';
const damolaAccountId = '0.0.7182103';
const damolaPrivateKey = '302e020100300506032b65700422042018fe1d735e60a81d90bc21c42bf75e0891b0d265bdc155eb4944658251ec9c4e';

const UssdDemoPage = () => {
  // --- State Management ---
  const [tundeDialer, setTundeDialer] = useState('');
  const [damolaDialer, setDamolaDialer] = useState('');

  const [showListForm, setShowListForm] = useState(false);
  const [listSerial, setListSerial] = useState('');
  const [listPrice, setListPrice] = useState('');
  const [isListing, setIsListing] = useState(false);

  const [showBuyForm, setShowBuyForm] = useState(false);
  const [buySerial, setBuySerial] = useState('');
  const [isBuying, setIsBuying] = useState(false);

  const [isConfirming, setIsConfirming] = useState(false);
  const [smsMessages, setSmsMessages] = useState([]);

  // --- Tunde's (Seller) Actions ---
  const handleTundeSend = async () => {
    if (tundeDialer === '*878*2*1#') {
      setShowListForm(true);
    } else {
      alert('Invalid USSD code for Tunde. Use *878*2*1# to list.');
    }
  };

  const handleTundeListSubmit = async (e) => {
    e.preventDefault();
    if (!listSerial || !listPrice) {
      alert('Please enter a serial number and a price.');
      return;
    }
    setIsListing(true);
    try {
      console.log(`Listing serial ${listSerial} for ${listPrice} HBAR...`);
      await handleList(tundeAccountId, tundePrivateKey, listPrice, listSerial);
      alert(`Successfully listed Serial #${listSerial} for ${listPrice} HBAR!`);
      setShowListForm(false);
      setListSerial('');
      setListPrice('');
    } catch (error) {
      console.error('Error listing asset:', error);
      alert(`Error listing asset: ${error.message}`);
    } finally {
      setIsListing(false);
    }
  };

  // --- Damola's (Buyer) Actions ---
  const handleDamolaSend = async () => {
    if (damolaDialer === '*878*3*1#') {
      setShowBuyForm(true);
    } else if (damolaDialer === '*878*4#') {
        await handleDamolaConfirmDelivery();
    } else {
      alert('Invalid USSD code for Damola. Use *878*3*1# to buy or *878*4# to confirm.');
    }
  };

  const handleDamolaConfirmDelivery = async () => {
    const serial = prompt("Enter the serial number to confirm delivery for:");
    if (!serial) return;

    setIsConfirming(true);
    try {
        const q = query(collection(db, "listings"), where("serialNumber", "==", Number(serial)));
        const querySnapshot = await getDocs(q);

        if (querySnapshot.empty) {
            throw new Error(`No listing found for serial number ${serial}`);
        }

        const listingDoc = querySnapshot.docs[0];
        const listingData = { id: listingDoc.id, ...listingDoc.data() };

        await confirmDelivery(damolaAccountId, damolaPrivateKey, listingData);

        const newMessage = `SMS to Damola: Your order (Serial ${serial}) is complete!`;
        setSmsMessages(prevMessages => [...prevMessages, newMessage]);
        alert(`Delivery confirmed for Serial #${serial}!`);

    } catch (error) {
        console.error('Error confirming delivery:', error);
        alert(`Error confirming delivery: ${error.message}`);
    } finally {
        setIsConfirming(false);
    }
  };

  const handleDamolaBuySubmit = async (e) => {
    e.preventDefault();
    if (!buySerial) {
        alert('Please enter the serial number of the product you wish to buy.');
        return;
    }
    setIsBuying(true);
    try {
        const q = query(collection(db, "listings"), where("serialNumber", "==", Number(buySerial)));
        const querySnapshot = await getDocs(q);

        if (querySnapshot.empty) {
            throw new Error(`No listing found for serial number ${buySerial}`);
        }

        const listingDoc = querySnapshot.docs[0];
        const listingData = { id: listingDoc.id, ...listingDoc.data() };

        console.log(`Buying serial ${buySerial}...`);
        await handleBuy(damolaAccountId, damolaPrivateKey, listingData);

        const newMessage = `SMS to Tunde: New Order for Serial ${buySerial}! Please dial *878*4*${buySerial}# to confirm delivery.`;
        setSmsMessages(prevMessages => [...prevMessages, newMessage]);

        alert(`Successfully purchased Serial #${buySerial}!`);
        setShowBuyForm(false);
        setBuySerial('');
    } catch (error) {
        console.error('Error buying asset:', error);
        alert(`Error buying asset: ${error.message}`);
    } finally {
        setIsBuying(false);
    }
  };


  return (
    <div className="ussd-demo-container">
      <h1>USSD Direct-Dial Simulator</h1>
      <div className="panels-container">
        {/* Tunde's Panel */}
        <div className="ussd-panel">
          <h2>Tunde (Seller)</h2>
          <div className="dialer-container">
            <input
              type="text"
              value={tundeDialer}
              onChange={(e) => setTundeDialer(e.target.value)}
              placeholder="Enter USSD Code"
              className="dialer-input"
            />
            <button onClick={handleTundeSend} className="send-button" disabled={isConfirming}>
              {isConfirming ? 'Confirming...' : 'Send'}
            </button>
          </div>
          <p>Try: <code>*878*2*1#</code> to list.</p>
        </div>

        {/* Damola's Panel */}
        <div className="ussd-panel">
          <h2>Damola (Buyer)</h2>
          <div className="dialer-container">
            <input
              type="text"
              value={damolaDialer}
              onChange={(e) => setDamolaDialer(e.target.value)}
              placeholder="Enter USSD Code"
              className="dialer-input"
            />
            <button onClick={handleDamolaSend} className="send-button" disabled={isConfirming}>
              {isConfirming ? 'Confirming...' : 'Send'}
            </button>
          </div>
          <p>Try: <code>*878*3*1#</code> to buy.</p>
          <p>Try: <code>*878*4#</code> to confirm.</p>
        </div>

        {/* SMS Inbox */}
        <div className="sms-inbox">
          <h3>Simulated SMS Inbox</h3>
          <div className="sms-messages-container">
            {smsMessages.map((msg, index) => (
              <p key={index} className="sms-message">{msg}</p>
            ))}
          </div>
        </div>
      </div>

      {/* List Product Modal */}
      {showListForm && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3>List Product</h3>
            <form onSubmit={handleTundeListSubmit}>
              <div className="form-group">
                <label htmlFor="serial">Serial Number</label>
                <input
                  id="serial"
                  type="text"
                  value={listSerial}
                  onChange={(e) => setListSerial(e.target.value)}
                  placeholder="e.g., 119"
                />
              </div>
              <div className="form-group">
                <label htmlFor="price">Price (in HBAR)</label>
                <input
                  id="price"
                  type="text"
                  value={listPrice}
                  onChange={(e) => setListPrice(e.target.value)}
                  placeholder="e.g., 10"
                />
              </div>
              <div className="modal-actions">
                <button type="button" onClick={() => setShowListForm(false)} disabled={isListing}>
                  Cancel
                </button>
                <button type="submit" disabled={isListing}>
                  {isListing ? 'Listing...' : 'List on Marketplace'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Buy Product Modal */}
      {showBuyForm && (
        <div className="modal-overlay">
            <div className="modal-content">
                <h3>Buy Product</h3>
                <form onSubmit={handleDamolaBuySubmit}>
                    <div className="form-group">
                        <label htmlFor="buy-serial">Serial Number</label>
                        <input
                            id="buy-serial"
                            type="text"
                            value={buySerial}
                            onChange={(e) => setBuySerial(e.target.value)}
                            placeholder="e.g., 119"
                        />
                    </div>
                    <div className="modal-actions">
                        <button type="button" onClick={() => setShowBuyForm(false)} disabled={isBuying}>
                            Cancel
                        </button>
                        <button type="submit" disabled={isBuying}>
                            {isBuying ? 'Purchasing...' : 'Buy Now'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
      )}
    </div>
  );
};

export default UssdDemoPage;
