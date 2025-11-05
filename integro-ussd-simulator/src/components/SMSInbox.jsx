import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, query, orderBy } from 'firebase/firestore';

const SMSInbox = () => {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(collection(db, 'listings'), orderBy('createdAt', 'desc'));
    const unsubscribe = onSnapshot(q, (querySnapshot) => {
      const listings = [];
      querySnapshot.forEach((doc) => {
        listings.push({ id: doc.id, ...doc.data() });
      });
      setMessages(listings);
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  return (
    <div className="sms-inbox-container">
      <h2>SMS Inbox</h2>
      {loading && <p>Loading marketplace...</p>}
      {!loading && messages.length === 0 && <p>No items in the marketplace.</p>}
      <ul className="sms-list">
        {messages.map((msg) => (
          <li key={msg.id} className="sms-message">
            <p><strong>From: Marketplace</strong></p>
            <p>Item: {msg.assetType}</p>
            <p>Price: {msg.price} HBAR</p>
            <p>Location: {msg.location}</p>
            <p>To buy, dial: *878*3*{msg.serialNumber}#</p>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default SMSInbox;
