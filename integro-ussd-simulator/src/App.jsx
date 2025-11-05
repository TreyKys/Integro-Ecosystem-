import React, { useState } from 'react';
import Phone from './components/Phone.jsx';
import SMSInbox from './components/SMSInbox.jsx';
import './App.css';

function App() {
  const [showInbox, setShowInbox] = useState(false);

  return (
    <div className="App">
      <Phone setShowInbox={setShowInbox} />
      {showInbox && <SMSInbox />}
    </div>
  );
}

export default App;
