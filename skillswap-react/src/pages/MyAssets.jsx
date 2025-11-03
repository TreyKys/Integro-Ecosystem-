import React, { useState, useEffect } from 'react';
import { useWallet } from '../context/WalletContext.jsx';
import { db, collection, query, where, getDocs, or } from '../firebase.js';
import BackButton from '../components/BackButton.jsx';
import { assetTokenId } from '../hedera.js';
import './MyAssets.css';

// Function to decode base64 metadata
const decodeMetadata = (base64) => {
    try {
        const json = atob(base64);
        return JSON.parse(json);
    } catch (e) {
        console.error("Failed to parse metadata:", e);
        return {};
    }
};

const MyAssets = () => {
    const { accountId, confirmDelivery, verifying } = useWallet();
    const [assets, setAssets] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isConfirming, setIsConfirming] = useState(null);

    const fetchAssets = async () => {
        if (!accountId) return;
        setIsLoading(true);
        try {
            // 1. Fetch NFTs from Hedera Mirror Node
            const mirrorNodeUrl = `https://testnet.mirrornode.hedera.com/api/v1/accounts/${accountId}/nfts?token.id=${assetTokenId}`;
            const response = await fetch(mirrorNodeUrl);
            if (!response.ok) {
                throw new Error(`Failed to fetch from mirror node: ${response.statusText}`);
            }
            const data = await response.json();
            const userNfts = data.nfts || [];

            // 2. Fetch listings from Firestore (both sold and purchased)
            const listingsRef = collection(db, "listings");
            const q = query(listingsRef,
                or(
                    where("sellerAccountId", "==", accountId),
                    where("buyerAccountId", "==", accountId)
                )
            );
            const querySnapshot = await getDocs(q);
            const firestoreListings = {};
            querySnapshot.forEach(doc => {
                const docData = doc.data();
                firestoreListings[docData.serialNumber] = {
                    ...docData,
                    id: doc.id
                };
            });

            // 3. Combine data
            const ownedAssets = userNfts.map(nft => {
                const metadata = decodeMetadata(nft.metadata);
                const firestoreInfo = firestoreListings[nft.serial_number];
                return {
                    serialNumber: nft.serial_number,
                    name: metadata.name || 'Untitled Asset',
                    description: metadata.description || 'No description.',
                    imageUrl: metadata.image || 'https://via.placeholder.com/150',
                    status: firestoreInfo ? firestoreInfo.status : 'In Wallet',
                    id: firestoreInfo ? firestoreInfo.id : null,
                };
            });

            // 4. Add purchased assets that are not yet transferred
            const purchasedAssets = Object.values(firestoreListings)
                .filter(listing => listing.buyerAccountId === accountId && !ownedAssets.find(a => a.serialNumber === listing.serialNumber))
                .map(listing => ({
                    ...listing, // contains name, description, imageUrl, etc. from Firestore
                    status: listing.status,
                }));

            setAssets([...ownedAssets, ...purchasedAssets]);
        } catch (error) {
            console.error("Failed to fetch assets:", error);
            setAssets([]); // Clear assets on error
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchAssets();
    }, [accountId]);

    const handleConfirmDelivery = async (asset) => {
        setIsConfirming(asset.serialNumber);
        try {
            await confirmDelivery(asset);
            // Re-fetch assets to reflect the change in ownership and status
            fetchAssets();
        } catch (error) {
            // It's helpful to show the error to the user in a real app
            console.error("Failed to confirm delivery:", error);
            alert(`Failed to confirm delivery: ${error.message}`);
        } finally {
            setIsConfirming(null);
        }
    };

    return (
        <div className="my-assets-container">
            <BackButton />
            <h2>My Digital Assets</h2>
            {isLoading ? (
                <p>Loading your assets from the Hedera network...</p>
            ) : assets.length > 0 ? (
                <div className="assets-grid">
                    {assets.map(asset => (
                        <div key={asset.serialNumber} className="asset-card">
                            <img src={asset.imageUrl} alt={asset.name} className="asset-image" />
                            <div className="asset-info">
                                <h3>{asset.name}</h3>
                                <p className="asset-serial">Serial: {asset.serialNumber}</p>
                                <div className="asset-status-wrapper">
                                    <span className={`status-badge status-${asset.status.toLowerCase().replace(/ /g, '-')}`}>
                                        {asset.status}
                                    </span>
                                </div>
                                {asset.status === 'Pending Delivery' && (
                                    <button
                                      onClick={() => handleConfirmDelivery(asset)}
                                      className="confirm-delivery-btn"
                                      disabled={isConfirming === asset.serialNumber}
                                    >
                                        {isConfirming === asset.serialNumber ? 'Confirming...' : 'Confirm Delivery'}
                                    </button>
                                )}
                                {verifying && isConfirming === asset.serialNumber && (
                                  <p className="verifying-text">Verifying transfer on-chain...</p>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            ) : (
                <div className="no-assets-container">
                    <p>You haven't minted or purchased any assets yet.</p>
                    <p>Visit the Marketplace to create or buy your first digital asset.</p>
                </div>
            )}
        </div>
    );
};

export default MyAssets;
