import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWallet } from '../context/WalletContext.jsx';
import './LandingPage.css';

const cloudFunctionUrl = "https://createaccount-cehqwvb4aq-uc.a.run.app";

const LandingPage = () => {
  const navigate = useNavigate();
  const { createVault } = useWallet();
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState('');

  const handleCreateVault = async () => {
    setIsProcessing(true);
    setStatus("1/2: Calling the secure Account Factory...");
    try {
      const response = await fetch(cloudFunctionUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Backend request failed.');
      }

      setStatus("2/2: Storing your secure credentials...");
      const { accountId, privateKey, evmAddress } = data;
      const normalizedPriv = privateKey.startsWith("0x") ? privateKey : "0x" + privateKey;

      createVault(accountId, normalizedPriv, evmAddress);
      navigate('/profile-setup');

    } catch (error) {
      console.error("Vault creation failed:", error);
      setStatus(`❌ Vault creation failed: ${error.message}`);
    } finally {
      setIsProcessing(false);
    }
  };

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
          }
        });
      },
      {
        threshold: 0.1,
      }
    );

    const sections = document.querySelectorAll('.fade-in-section');
    sections.forEach((section) => observer.observe(section));

    return () => sections.forEach((section) => observer.unobserve(section));
  }, []);

  return (
    <main className="lp-container">
      <section className="lp-hero">
        <header className="lp-header">
          {/* Logo removed as per instructions */}
        </header>
        <div className="lp-hero-content">
          <h1>AFRICA'S INFORMAL ECONOMY RUNS ON TRUST - BUT TRUST IS FRAGILE</h1>
          <div className="lp-cta-buttons">
            <button onClick={handleCreateVault} className="lp-cta-button" disabled={isProcessing}>
              {isProcessing ? 'Creating Vault...' : 'Create Your Secure Vault'}
            </button>
            <button onClick={() => navigate('/ussd-demo')} className="lp-cta-button secondary">
              USSD Demo
            </button>
          </div>
          {status && <p className="status-message">{status}</p>}
        </div>
      </section>

      <section className="lp-section lp-mission fade-in-section">
        <div className="lp-mission-content">
          <div className="lp-mission-text-column">
            <h2>INTEGRO'S MISSION</h2>
            <p>
              Integro's mission is to build a trusted ecosystem where Africa's
              informal economy can easily connect, transact, and thrive
            </p>
          </div>
          <div className="lp-mission-images-column">
            <img
              src="https://i.postimg.cc/xC9YSRCh/1761796817228.png"
              alt="[Image 1: Red Car]"
              className="lp-mission-image"
            />
            <img
              src="https://i.postimg.cc/ZR5gcD0m/Gemini-Generated-Image-pv78wtpv78wtpv78-2.jpg"
              alt="[Image 2: Car Interior]"
              className="lp-mission-image"
            />
          </div>
        </div>
      </section>

      <section className="lp-section lp-features fade-in-section">
        <div className="lp-features-content">
          <div className="lp-features-left">
            <h2>FEATURES</h2>
            <div className="lp-features-grid">
              <div className="lp-feature-item">
                <span>1</span>
                <h3>Multi-Layered Trust Engine</h3>
                <p>
                  Your digital shield: Protecting you from bad actors by
                  verifying every asset and eliminating fraud.
                </p>
              </div>
              <div className="lp-feature-item">
                <span>2</span>
                <h3>Three Arms - One Ecosystem</h3>
                <p>Trade, fund, and deliver—all in one seamless platform.</p>
              </div>
              <div className="lp-feature-item">
                <span>3</span>
                <h3>Real-World Asset (RWA) Tokenization</h3>
                <p>
                  Unlock the true digital value of your physical goods and
                  services.
                </p>
              </div>
              <div className="lp-feature-item">
                <span>4</span>
                <h3>Accessible by All</h3>
                <p>
                  No smartphone? No problem. Access Web3 power via simple SMS.
                </p>
              </div>
            </div>
          </div>
          <div className="lp-features-right">
            <img
              src="https://i.postimg.cc/vH5sDkVf/hedera-hashgraph-810x524.jpg"
              alt="[Image 3: Car Dashboard]"
              className="lp-features-image"
            />
            <h2 className="lp-hedera-text">Built on Hedera</h2>
          </div>
        </div>
      </section>

      <section className="lp-section lp-final-cta fade-in-section">
        <div className="lp-final-cta-content">
          <h2>BUILDING THE TRUST LAYER FOR AFRICA'S INFORMAL ECONOMY</h2>
        </div>
      </section>
    </main>
  );
};

export default LandingPage;
