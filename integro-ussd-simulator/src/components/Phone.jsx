import React, { useState } from 'react';
import { getFunctions, httpsCallable } from 'firebase/functions';

const Phone = ({ setShowInbox }) => {
  const [screenText, setScreenText] = useState('Welcome! Dial *878*1# to create an account, *878*2# to list a product, or *878*3# to view the marketplace.');
  const [dialerInput, setDialerInput] = useState('');
  const [userSession, setUserSession] = useState(null);
  const [currentStep, setCurrentStep] = useState('idle');
  const [tempData, setTempData] = useState({});

  const createAccount = async (name, pin) => {
    try {
      setScreenText('Creating your account...');
      const functions = getFunctions();
      const createAccount_ussd = httpsCallable(functions, 'createAccount_ussd');
      const result = await createAccount_ussd({ name, pin });
      const { accountId, privateKey, evmAddress } = result.data;
      setUserSession({ accountId, privateKey, evmAddress });
      setScreenText(`Congratulations! Account created. ID: ${accountId}`);
      setCurrentStep('idle');
    } catch (error) {
      console.error("Error creating account:", error);
      setScreenText('Error: Could not create account.');
      setCurrentStep('idle');
    }
  };

  const listAsset = async (assetData) => {
    // ... (previous implementation)
  };

  const purchaseAsset = async (serialNumber, pin) => {
    try {
      if (!userSession) {
        setScreenText('Error: You must be logged in to purchase an asset.');
        return;
      }
      setScreenText('Funding escrow...');

      // Placeholder for fundEscrow_ussd
      console.log('Calling fundEscrow_ussd with:', {
        accountId: userSession.accountId,
        privateKey: userSession.privateKey,
        serialNumber: serialNumber,
        pin: pin,
      });

      setScreenText('Confirming delivery...');

      // Placeholder for confirmDelivery_ussd
      console.log('Calling confirmDelivery_ussd with:', {
        accountId: userSession.accountId,
        privateKey: userSession.privateKey,
        serialNumber: serialNumber,
      });

      setScreenText('Purchase successful!');
      setCurrentStep('idle');

    } catch (error) {
      console.error("Error purchasing asset:", error);
      setScreenText('Error: Could not purchase asset.');
      setCurrentStep('idle');
    }
  };

  const handleSend = async () => {
    if (currentStep === 'idle') {
      const purchaseMatch = dialerInput.match(/^\\*878\\*3\\*(\\d+)#$/);
      if (dialerInput === '*878*1#') {
        setCurrentStep('create_account_name');
        setScreenText('Enter your name:');
        setDialerInput('');
      } else if (dialerInput === '*878*2#') {
        // ... (previous implementation)
      } else if (dialerInput === '*878*3#') {
        setScreenText('Opening SMS Inbox to view marketplace...');
        setShowInbox(true);
        setDialerInput('');
      } else if (purchaseMatch) {
        const serialNumber = purchaseMatch[1];
        setTempData({ serialNumber });
        setCurrentStep('purchase_pin');
        setScreenText(`Enter your 4-digit PIN to confirm purchase of asset ${serialNumber}:`);
        setDialerInput('');
      } else {
        setScreenText('Invalid code.');
      }
    } else if (currentStep === 'create_account_name') {
      // ... (previous implementation)
    } else if (currentStep === 'create_account_pin') {
      // ... (previous implementation)
    } else if (currentStep.startsWith('list_asset')) {
      // ... (previous implementation)
    } else if (currentStep === 'purchase_pin') {
      if (/^\\d{4}$/.test(dialerInput)) {
        await purchaseAsset(tempData.serialNumber, dialerInput);
        setDialerInput('');
      } else {
        setScreenText('Invalid PIN. Please enter a 4-digit PIN:');
      }
    }
  };

  return (
    <div className="phone-container">
      <pre className="phone-screen">{screenText}</pre>
      <div className="phone-dialer">
        <input
          type="text"
          value={dialerInput}
          onChange={(e) => setDialerInput(e.target.value)}
          placeholder="Enter USSD code or value"
        />
        <button onClick={handleSend}>Send</button>
      </div>
    </div>
  );
};

export default Phone;
