import React from 'react';
import { Link } from 'react-router-dom';
import './Layout.css'; // Using the same CSS file for layout components

// Minimalist SVG Icons
const MarketplaceIcon = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path><line x1="3" y1="6" x2="21" y2="6"></line><path d="M16 10a4 4 0 0 1-8 0"></path></svg>;
const FinanceIcon = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>;
const LogisticsIcon = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="1" y="3" width="15" height="13"></rect><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon><circle cx="5.5" cy="18.5" r="2.5"></circle><circle cx="18.5" cy="18.5" r="2.5"></circle></svg>;
const AgentIcon = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>;
const ProfileIcon = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5.52 19c.64-2.2 1.84-3 3.22-3h6.52c1.38 0 2.58.8 3.22 3"></path><circle cx="12" cy="10" r="3"></circle><circle cx="12" cy="12" r="10"></circle></svg>;
const AssetsIcon = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>;
const UssdIcon = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 10h-1.26A8 8 0 1 0 4 16.25"></path><path d="M8 16a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v4a1 1 0 0 1-1-1H9a1 1 0 0 1-1-1v-4"></path><line x1="12" y1="12" x2="12" y2="12"></line></svg>;
const AboutIcon = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>;


const Sidebar = ({ isOpen, onClose }) => {
    return (
        <>
            <div className={`sidebar ${isOpen ? 'open' : ''}`}>
                <div className="sidebar-header">
                    <h3>Menu</h3>
                    <button onClick={onClose} className="close-btn">&times;</button>
                </div>
                <nav className="sidebar-nav">
                    <h4 className="menu-header">ECOSYSTEM</h4>
                    <ul>
                        <li><Link to="/marketplace" onClick={onClose}><MarketplaceIcon /> Marketplace</Link></li>
                        <li className="sub-item"><Link to="/lending-pool" onClick={onClose}><FinanceIcon /> Finance</Link>
                            <ul className="sub-menu">
                                <li><Link to="/lending-pool" onClick={onClose}>RWA Futures</Link></li>
                                <li><Link to="/lending-pool" onClick={onClose}>Lending Pool</Link></li>
                            </ul>
                        </li>
                        <li className="sub-item"><Link to="/agent-staking" onClick={onClose}><LogisticsIcon /> Logistics</Link>
                             <ul className="sub-menu">
                                <li><Link to="/agent-staking" onClick={onClose}>Create Delivery Gig</Link></li>
                            </ul>
                        </li>
                        <li><Link to="/agent-staking" onClick={onClose}><AgentIcon /> Become an Agent</Link></li>
                    </ul>
                    <h4 className="menu-header">PROFILE & ACCOUNT</h4>
                    <ul>
                        <li><Link to="/profile" onClick={onClose}><ProfileIcon /> User Profile</Link></li>
                        <li><Link to="/my-assets" onClick={onClose}><AssetsIcon /> My Assets</Link></li>
                    </ul>
                    <h4 className="menu-header">SPECIAL FEATURE</h4>
                    <ul>
                        <li><Link to="/ussd-simulator" onClick={onClose}><UssdIcon /> USSD</Link></li>
                    </ul>
                    <h4 className="menu-header">ABOUT</h4>
                    <ul>
                        <li><Link to="#" onClick={onClose}><AboutIcon /> About Integro</Link></li>
                    </ul>
                </nav>
            </div>
            {isOpen && <div className="overlay" onClick={onClose}></div>}
        </>
    );
};

export default Sidebar;
