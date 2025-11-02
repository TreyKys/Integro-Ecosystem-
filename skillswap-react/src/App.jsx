import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { WalletProvider, useWallet } from './context/WalletContext.jsx';
import Marketplace from './pages/Marketplace.jsx';
import './App.css';

import LandingPage from './pages/LandingPage.jsx';
import CreateListing from './pages/CreateListing.jsx';
import MyAssets from './pages/MyAssets.jsx';
import LendingPool from './pages/LendingPool.jsx';
import AgentStaking from './pages/AgentStaking.jsx';
import Layout from './components/Layout.jsx';
import LendingPoolOverview from './pages/Finance/LendingPoolOverview.jsx';
import TakeLoan from './pages/Finance/TakeLoan.jsx';
import MyLoans from './pages/Finance/MyLoans.jsx';
import DepositLiquidity from './pages/Finance/DepositLiquidity.jsx';
import RepayLoan from './pages/Finance/RepayLoan.jsx';
import ProfilePage from './pages/ProfilePage.jsx';
import USSDSimulator from './pages/USSDSimulator.jsx';

function App() {
  return (
    <WalletProvider>
      <Router>
        <AppContent />
      </Router>
    </WalletProvider>
  );
}

function AppContent() {
  const { accountId, userProfile, isLoaded } = useWallet();

  if (!isLoaded) {
    return <div className="loading-container">Restoring your vault...</div>;
  }

  return (
    <Routes>
      <Route path="/" element={!accountId ? <LandingPage /> : <Navigate to="/marketplace" />} />
      <Route
        path="/*"
        element={accountId ? <ProtectedRoutes /> : <Navigate to="/" />}
      />
    </Routes>
  );
}

const ProtectedRoutes = () => {
  return (
    <Layout>
      <Routes>
        <Route path="/marketplace" element={<Marketplace />} />
        <Route path="/create-listing" element={<CreateListing />} />
        <Route path="/my-assets" element={<MyAssets />} />
        <Route path="/lending-pool" element={<Navigate to="/lending-pool-overview" />} />
        <Route path="/lending-pool-overview" element={<LendingPoolOverview />} />
        <Route path="/take-loan" element={<TakeLoan />} />
        <Route path="/my-loans" element={<MyLoans />} />
        <Route path="/deposit-liquidity" element={<DepositLiquidity />} />
        <Route path="/repay-loan" element={<RepayLoan />} />
        <Route path="/agent-staking" element={<AgentStaking />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/ussd-simulator" element={<USSDSimulator />} />
        {/* Add other protected routes here */}
        <Route path="*" element={<Navigate to="/marketplace" />} />
      </Routes>
    </Layout>
  );
};

export default App;
