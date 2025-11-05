import React, { useState } from 'react';
import Phone from './components/Phone';
import SMSInbox from './components/SMSInbox';

function App() {
  const [messages, setMessages] = useState([
    { id: 1, text: 'Welcome to the USSD Simulator!' },
    { id: 2, text: 'Dial *878*1# to create an account.' },
  ]);

  return (
    <div className="App">
      <h1>USSD Simulator</h1>
      <div style={{ display: 'flex', justifyContent: 'center', gap: '20px', alignItems: 'flex-start' }}>
        <Phone setMessages={setMessages} />
        <SMSInbox messages={messages} />
      </div>
    </div>
  );
}

export default App;
