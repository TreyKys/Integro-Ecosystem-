import React from 'react';

const ProfilePage = () => {
    const handleAgentSignup = async () => {
        try {
            // TODO: Move URL to a config file
            const createAgentUrl = "https://us-central1-integro-ecosystem.cloudfunctions.net/createAgent";
            const displayName = document.getElementById('agent-name').value;
            const accountId = document.getElementById('agent-accountId').value; // e.g., 0.0.723xxx
            const role = document.getElementById('agent-role').value; // DELIVERY_AGENT or VERIFIER
            const contact = { phone: document.getElementById('agent-phone').value };
            const resp = await fetch(createAgentUrl, {
                method: 'POST',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ accountId, displayName, role, contact })
            });
            const json = await resp.json();
            if (!resp.ok) throw new Error(json.error || JSON.stringify(json));
            alert('Agent created: ' + json.agentId);
            // update UI: show agent id, HCS anchor, etc.
        } catch (err) {
            console.error(err);
            alert('Agent registration failed: ' + (err.message || err));
        }
    }

    return (
        <div>
            <h1>User Profile</h1>
            <p>This is the user profile page. It is currently under construction.</p>

            <div className="card">
                <h3>Become an Agent</h3>
                <input id="agent-name" placeholder="Display Name" />
                <input id="agent-accountId" placeholder="Hedera Account ID" />
                <select id="agent-role">
                    <option value="DELIVERY_AGENT">DELIVERY_AGENT</option>
                    <option value="VERIFICATION_AGENT">VERIFICATION_AGENT</option>
                </select>
                <input id="agent-phone" placeholder="Phone Number" />
                <button onClick={handleAgentSignup}>Sign Up as Agent</button>
            </div>
        </div>
    );
};

export default ProfilePage;
