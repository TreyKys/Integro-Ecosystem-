import React, { useState, useEffect } from 'react';
import { useWallet } from '../context/WalletContext';

const BecomeAgent = () => {
  const { accountId } = useWallet();
  const [agentId, setAgentId] = useState(localStorage.getItem('agentId'));
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState('VERIFICATION_AGENT');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSignup = async (e) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      const response = await fetch('https://us-central1-integro-ecosystem.cloudfunctions.net/createAgent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId,
          displayName,
          role,
          contact: { phone },
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to create agent.');
      }
      localStorage.setItem('agentId', data.agentId);
      setAgentId(data.agentId);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (agentId) {
    return <AgentDashboard agentId={agentId} />;
  }

  return (
    <div className="become-agent-container">
      <h2>Become An Agent</h2>
      <form onSubmit={handleSignup} className="agent-signup-form">
        <div className="form-group">
          <label htmlFor="displayName">Display Name</label>
          <input
            id="displayName"
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
          />
        </div>
        <div className="form-group">
          <label htmlFor="role">Role</label>
          <select id="role" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="VERIFICATION_AGENT">Verification Agent</option>
            <option value="DELIVERY_AGENT">Delivery Agent</option>
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="phone">Phone Number</label>
          <input
            id="phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>
        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Submitting...' : 'Sign Up'}
        </button>
        {error && <p className="error-message">{error}</p>}
      </form>
    </div>
  );
};

const ListingCard = ({ listing, agentId, onClaim, onVerify }) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [evidence, setEvidence] = useState('');

  const handleVerifyClick = () => {
    setIsModalOpen(true);
  };

  const handleModalSubmit = () => {
    onVerify(listing.listingId, { notes: evidence });
    setIsModalOpen(false);
  };

  const isClaimedByMe = listing.assignedAgent === agentId;

  return (
    <div className="listing-card">
      <h3>{listing.title}</h3>
      <p><strong>Seller:</strong> {listing.sellerAccountId}</p>
      <p><strong>Price:</strong> {listing.priceHbar} ℏ</p>
      <p><strong>Status:</strong> {listing.state}</p>
      <div className="listing-actions">
        {listing.state === 'PENDING_VERIFICATION' && (
          <button onClick={() => onClaim(listing.listingId)}>Claim</button>
        )}
        <button onClick={handleVerifyClick} disabled={!isClaimedByMe || listing.state !== 'UNDER_VERIFICATION'}>
          Verify
        </button>
      </div>
      {isModalOpen && (
        <VerificationModal
          onClose={() => setIsModalOpen(false)}
          onSubmit={handleModalSubmit}
          evidence={evidence}
          setEvidence={setEvidence}
        />
      )}
    </div>
  );
};

const VerificationModal = ({ onClose, onSubmit, evidence, setEvidence }) => {
  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <h3>Verify Listing</h3>
        <textarea
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
          placeholder="Add evidence notes here..."
        />
        <div className="modal-actions">
          <button onClick={onSubmit}>Submit Verification</button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
};

const AgentDashboard = ({ agentId }) => {
  const { accountId } = useWallet();
  const [listings, setListings] = useState([]);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const fetchListings = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const response = await fetch('https://us-central1-integro-ecosystem.cloudfunctions.net/getListings?state=PENDING_VERIFICATION');
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || 'Failed to fetch listings.');
        }
        setListings(data);
      } catch (err) {
        setError(err.message);
      } finally {
        setIsLoading(false);
      }
    };
    fetchListings();
  }, []);

  const handleClaim = async (listingId) => {
    try {
      const response = await fetch('https://us-central1-integro-ecosystem.cloudfunctions.net/claimListing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          listingId,
          agentId,
          agentAccountId: accountId,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to claim listing.');
      }
      // Refresh listings after claiming
      const updatedListings = listings.map(l => l.listingId === listingId ? { ...l, state: 'UNDER_VERIFICATION', assignedAgent: agentId } : l);
      setListings(updatedListings);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleVerify = async (listingId, evidence) => {
    try {
      const response = await fetch('https://us-central1-integro-ecosystem.cloudfunctions.net/verifyListing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          listingId,
          agentId,
          agentAccountId: accountId,
          evidence,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to verify listing.');
      }
      // Refresh listings after verifying
      const updatedListings = listings.map(l => l.listingId === listingId ? { ...l, state: 'VERIFIED' } : l);
      setListings(updatedListings);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="agent-dashboard">
      <h2>Agent Dashboard</h2>
      <p>Your Agent ID is: {agentId}</p>
      {isLoading && <p>Loading listings...</p>}
      {error && <p className="error-message">{error}</p>}
      <div className="listings-container">
        {listings.map((listing) => (
          <ListingCard
            key={listing.listingId}
            listing={listing}
            agentId={agentId}
            onClaim={handleClaim}
            onVerify={handleVerify}
          />
        ))}
      </div>
    </div>
  );
};

export default BecomeAgent;
