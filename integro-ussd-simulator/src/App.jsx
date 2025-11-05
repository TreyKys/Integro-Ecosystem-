import { useState, useEffect } from 'react';
import './App.css';
import { ussdGateway, db } from './firebase';
import { collection, query, where, onSnapshot } from "firebase/firestore";

const Phone = ({ title, screenText, onEnter, accountId, setAccountId }) => {
  const [ussdString, setUssdString] = useState('');

  const handleInputChange = (e) => {
    setUssdString(e.target.value);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      onEnter(ussdString, accountId, setAccountId);
      setUssdString('');
    }
  };

  return (
    <div className="phone">
      <div className="phone-header">{title}</div>
      <div className="screen">
        {accountId && <div className="account-id">Account: {accountId}</div>}
        {screenText}
      </div>
      <div className="input-area">
        <input
          type="text"
          className="input-field"
          value={ussdString}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder="Enter USSD string..."
        />
      </div>
    </div>
  );
};

const SmsInbox = ({ messages }) => (
    <div className="sms-inbox">
        <h3>SMS Inbox</h3>
        {messages.length === 0 && <p>No messages yet.</p>}
        {messages.map((msg, index) => (
            <div key={index} className="sms">
                <strong>From: {msg.from}</strong>
                <p>{msg.text}</p>
            </div>
        ))}
    </div>
);


function App() {
  const [sellerScreen, setSellerScreen] = useState('Welcome!\\nEnter *878# and press Enter.');
  const [buyerScreen, setBuyerScreen] = useState('Welcome!\\nEnter *878# and press Enter.');
  const [sellerSms, setSellerSms] = useState([]);
  const [buyerSms] = useState([]); // Buyer SMS not used in this flow
  const [sellerAccountId, setSellerAccountId] = useState(null);
  const [buyerAccountId, setBuyerAccountId] = useState(null);

  // SMS Listener for Seller
  useEffect(() => {
    if (!sellerAccountId) return;
    const q = query(collection(db, `sms_inbox/${sellerAccountId}/messages`));
    const unsubscribe = onSnapshot(q, (querySnapshot) => {
      const messages = [];
      querySnapshot.forEach((doc) => {
        messages.push({ from: 'Network', ...doc.data() });
      });
      setSellerSms(messages);
    });
    return () => unsubscribe();
  }, [sellerAccountId]);


  const handleUssdEnter = async (ussd, accountId, setAccountId, setScreen) => {
    setScreen(`Dialed: ${ussd}\\n...connecting...`);
    try {
      const result = await ussdGateway({ text: ussd, accountId: accountId });
      const responseText = result.data.text.replace(/\\n/g, '\\n');

      if (responseText.startsWith('END Congratulations!')) {
         const newAccountId = responseText.split('\\n')[1];
         setAccountId(newAccountId);
      }

      setScreen(responseText.replace(/^CON /g, '').replace(/^END /g, ''));

    } catch (error) {
      console.error("Error calling ussdGateway:", error);
      setScreen(`Error: ${error.message}`);
    }
  };


  return (
    <>
      <h1>Integro USSD Simulator</h1>
      <h2>Building the Trust Layer for Africa's Informal Economy</h2>
      <div className="app-container">
        <div>
            <h2>Seller's Phone</h2>
            <Phone
              title="Seller"
              screenText={sellerScreen}
              onEnter={(ussd) => handleUssdEnter(ussd, sellerAccountId, setSellerAccountId, setSellerScreen)}
              accountId={sellerAccountId}
              setAccountId={setSellerAccountId}
            />
            <SmsInbox messages={sellerSms} />
        </div>
        <div>
            <h2>Buyer's Phone</h2>
            <Phone
              title="Buyer"
              screenText={buyerScreen}
              onEnter={(ussd) => handleUssdEnter(ussd, buyerAccountId, setBuyerAccountId, setBuyerScreen)}
              accountId={buyerAccountId}
              setAccountId={setBuyerAccountId}
            />
            <SmsInbox messages={buyerSms} />
        </div>
      </div>
    </>
  );
}

export default App;
