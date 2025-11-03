import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { getApp } from "firebase/app";
import { getFunctions, httpsCallable } from "firebase/functions";

function UssdDemoPage() {
    const [createVaultName, setCreateVaultName] = useState('');
    const [createVaultEmail, setCreateVaultEmail] = useState('');
    const [createVaultPin, setCreateVaultPin] = useState('');
    const [output, setOutput] = useState('Output will appear here.');

    const handleCreateVault = async () => {
        setOutput('Processing... creating account...');

        const data = {
            fullName: createVaultName,
            email: createVaultEmail,
            pin: createVaultPin
        };

        try {
            const app = getApp();
            const functions = getFunctions(app);
            const createAccount = httpsCallable(functions, 'createAccount');
            const result = await createAccount(data);

            setOutput(`SUCCESS! Account ${result.data.newAccountId} created for ${data.fullName}.`);

        } catch (error) {
            console.error("Create Vault Error:", error);
            setOutput(`Error: ${error.message}`);
        }
    };

    return (
        <div>
            <Link to="/">← Back to Main Site</Link>

            <h1>USSD Command Board (Demo)</h1>

            <p>This page proves a non-app interface can run our Golden Path.</p>

            <div>
                <h2>1. Run: *878*1# (Create Vault)</h2>

                <input
                    type="text"
                    placeholder="Full Name"
                    value={createVaultName}
                    onChange={(e) => setCreateVaultName(e.target.value)}
                />

                <input
                    type="email"
                    placeholder="Email"
                    value={createVaultEmail}
                    onChange={(e) => setCreateVaultEmail(e.target.value)}
                />

                <input
                    type="password"
                    placeholder="4-Digit PIN"
                    value={createVaultPin}
                    onChange={(e) => setCreateVaultPin(e.target.value)}
                />
                <button onClick={handleCreateVault}>Create Vault</button>
            </div>

            <div>
                <h2>Output:</h2>
                <pre>{output}</pre>
            </div>
        </div>
    );
}

export default UssdDemoPage;
