import React from 'react';

const SMSInbox = ({ messages }) => {
  return (
    <div style={{ border: '1px solid black', padding: '10px', width: '300px', backgroundColor: '#f5f5f5' }}>
      <h3 style={{ marginTop: 0, textAlign: 'center' }}>SMS Inbox</h3>
      {messages.slice().reverse().map((message, index) => ( // Show newest first
        <div
          key={index}
          style={{
            borderBottom: '1px solid #eee',
            padding: '8px 5px',
            backgroundColor: 'white',
            marginBottom: '5px',
            borderRadius: '4px'
          }}
        >
          {message.text}
        </div>
      ))}
    </div>
  );
};

export default SMSInbox;
