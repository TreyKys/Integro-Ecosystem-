
*Project Integro — Trust Engine for the Informal Economy*

Track: DLT for Operations
TRL: 4–6 (Working prototype; stable Golden Path deployed)

Live demo: https://integro-hed.netlify.app
Demo video: https://youtu.be/g0xtMrfzN9U?si=MeBhpT89FnLRyC3m
Pitch deck: https://docs.google.com/presentation/d/1odNrYgbW6caQov2oztkxDawTvbzmURmCN2XT4r5bkGI/edit?usp=drivesdk
Hedera certification: https://i.postimg.cc/BbJYZ1j9/205e97fd-e799-4d51-a82f-c0b09a53aa4d-1.png


Integro aims to remove the two biggest barriers keeping Africa’s informal economy locked out of scalable markets: (1) lack of verifiable trust for goods & people, and (2) lack of access for feature-phone users. We tokenize real goods as Hedera NFTs, secure payments with an on-chain escrow, and let buyers and sellers on feature phones complete tokenized trades using a PIN-protected USSD bridge. The result: verifiable transactions, instant settlement paths, and on-ramp to credit and finance for communities previously excluded.

Why this is important — problem & opportunity

The informal economy in Africa is vast — trillions USD in annual value — yet lacks verifiable identity, transparent settlement, and accessible digital rails. That suppresses liquidity, increases fraud, and excludes billions from formal finance.

Existing blockchain demos often target smartphone/crypto users. But ~85% of our target users - Africans - still use feature phones. A solution that actually reaches them will unlock a new wave of inclusion.

Integro’s unique combination — USSD accessibility + Hedera native tokenization + escrowed settlement — is a practical, low-cost, and verifiable way to move real goods + money on chain for those who need it most.



What we built — headline features (stable demo)

Account factory (non-custodial): create Hedera ECDSA accounts with private key returned to the user (demoed).

RWA NFT minting (HTS): mintRWAviaUSSD mints IVA NFTs for real goods (token ID used in demo: 0.0.7134449).

Smart-contract escrow (HSCS): Escrow.sol locks funds until delivery is confirmed (Escrow contract: 0.0.7182623).

Allowance-based NFT transfer: secure transfer of NFT ownership after confirmDelivery — seller retains custody until final settlement.

PIN-protected server signing (PPSSS prototype, still building - under active development): USSD flows use a PIN to authenticate actions; server signs limited transactions via a dedicated signer for USSD convenience while minimizing exposure.

Hybrid UX: Marketplace web app (React) + USSD bridge for buyers/sellers (backend functions). Agents (verification) are web-only (Under active development)

Mirrored off-chain UX state: Firestore mirrors marketplace state so web + USSD menus show consistent information.



---

The real envisioned Golden Path 


> Important IDs 

IVA-NFT Token ID: 0.0.7134449

Escrow Contract ID: 0.0.7182623

Firebase functions (example base): https://us-central1-integro-ecosystem.cloudfunctions.net/...




0. Prep (1–2 min)

Open two browsers (or one web + USSD simulator) to show buyer and seller separation.

Ensure HashScan / Mirror Node are available: https://hashscan.io/testnet/ and https://testnet.mirrornode.hedera.com/.


1. Seller: Create account (createAccount)

Call createAccount via the web UI (or via function URL).

Expected: a new Hedera account id (e.g., 0.0.xxxxx) and an ECDSA private key (returned to client).

Verify: Check account existence on Mirror Node / HashScan by accountId.


2. Seller: Mint RWA NFT (mintRWAviaUSSD)

Seller mints a RWA NFT to their newly created account using mintRWAviaUSSD (metadata includes assetType/location/quality).

Expected: Mint transaction receipt with serial number(s). The function returns { tokenId: "0.0.7134449", serialNumber: <n> }.

Verify: Use HashScan to view the HTS mint transaction and the NFT serial.


3. Seller: List item in marketplace (web UI or USSD)

Seller creates a listing stored in Firestore with state: PENDING_VERIFICATION (or immediately visible if verified).

Expected: Listing record in Firestore (collection listings/{listingId}).

Verify: Open Firestore console to show the listing document.


4. Agent (web-only): Claim & Verify (Claim → Verify)

Agent (web) claims the listing and runs verification (optional in demo — you can use a built agent account to verify immediately).

Expected: Listing state changes to VERIFIED with tokenId and serialNumber populated and HCS anchor (if active branch used).

Verify: Firestore listing updated; HashScan shows HCS anchor if HCS was used.


5. Buyer: BuyNow → fundEscrow

Buyer selects listing and triggers fundEscrow (via web or USSD + PPSSS).

Payload (example):


{
  "escrowContractId":"0.0.7182623",
  "tokenId":"0.0.7134449",
  "amountHbar": 1
}

Expected: Smart-contract function fundEscrow transaction receipt (transaction id). Firestore purchase document created: purchases/{purchaseId} with state: FUNDED and fundTxId.

Verify: Check HashScan for contract call and Firestore for purchase doc.


6. Seller: Mark delivered → buyer confirms delivery (confirmDelivery)

Buyer confirms delivery. Call confirmDelivery against escrow contract (via web app or PPSSS flow on USSD).

Expected: Smart-contract confirmDelivery transaction receipt — escrow logic releases funds; on success, backend triggers NFT transfer (allowance-based) via executeNativeNftTransfer. purchases/{purchaseId} updates with confirmTxId and nftTransferTxId.

Verify: Confirm on HashScan: escrow confirm tx and the TransferTransaction moving NFT from seller → buyer.


7. Audit proof (HashScan / Mirror Node)

For both escrow and NFT transfer transactions, open HashScan for transaction details and the Mirror Node for consensus timestamps. Show the chain of receipts as indisputable proof.



---

Trust Engine - 5 verification points, ensures security. 

1. End-to-end receipts — show both the escrow fundEscrow receipt and the confirmDelivery receipt on HashScan.


2. NFT serial evidence — the minted serial on HTS and the final addNftTransfer transfer receipt.


3. Account separation — buyer and seller must be different Hedera accounts created in step 1.


4. Firestore state mirrors — listings and purchases documents reflect the on-chain actions.


5. USSD + Web parity — show that the same purchase flow can be initiated from USSD (via PPSSS) or Web with matching results.




---

Real-world impact — how Integro changes lives

We frame impact in three immediate, verifiable ways:

1. Faster access to payment & liquidity (farmers & traders)

Problem today: Farmer sells goods at market, trusted buyer pays later or not at all; no formal receipt to collateralize loans.

Integro outcome: Each sale mints a verifiable NFT receipt and uses escrow for immediate, conditional settlement. Farmers can use the NFT + on-chain proof to access micro-credit or forward-sale financing the same day instead of waiting weeks.


Estimated immediate benefit (conservative): If 10% of a local market adopts immediate tokenized receipts, sellers can unlock days/weeks of working capital — lowering lost-sales and improving income stability.

2. Drastically lower fraud & disputes (market integrity)

Problem today: Disputes resolved offline — slow & opaque.

Integro outcome: Delivery confirmations, NFT receipts, and HCS anchors create auditable evidence. Dispute resolution becomes quantitative: HashScan + Firestore logs show transaction trail and timestamps. This reduces time-to-resolve and lowers dispute costs for small merchants.


3. Financial inclusion cascade (credit + marketplaces)

Problem today: No reliable, verifiable on-chain collateral accepted by lenders.

Integro outcome: Tokenized goods + transaction history = creditworthy digital footprint. Small merchants gain access to micro-loans, input financing, and on-chain marketplaces beyond the local market.



---

Advantages over “complete” but non-hybrid projects (concise)

Reach: Many polished dapps assume smartphone wallets; Integro reaches feature-phone users via USSD (the actual majority in many regions). That access multiplies the addressable market dramatically.

Practicality: We focused on one repeatable golden path (mint → list → escrow → deliver → transfer) and hardened it for demo reliability. This is better for live judging than a broad, untested feature set.

Economics: Hedera’s low, predictable fees mean micro-transactions and per-message HCS anchoring are affordable at scale — critical for low-margin goods. We also tried using EVM tools but ultimately found out that their unstable and unreliable compared to Hedera's tools and SDKs

Clear expansion path: PPSSS → HCS anchors → agent staking are incremental and demonstrable; we can show both the stable demo and the active branch roadmap on request.



---

Security & privacy notes 

Non-custodial account model: createAccount returns private key — the demo demonstrates seedless user control. For production, keys must be stored in secure keychains.

PPSSS tradeoff: PPSSS provides convenience for USSD but introduces a server-side signing key; we minimize trust by restricting its signing surface and will replace with KMS/HSM & device delegation for production.

Agent operations: agents are web-only and require authenticated role checks before claim/verify actions (to prevent USSD abuse).



---

What’s in the active development branch (not in stable demo)

Full HCS anchoring for DID, listing lifecycle, delivery confirmations (audit trail).

More robust PPSSS hardening (KMS integration & narrower signing surface).

Delivery gig automation, agent staking & slashing smart contract spec (demo/test mode).

USSD stateful UI improvements and human-readable listing strings for SMS menus.


> We keep the stable branch deployed for live demos because it has the cleanest, most reliable golden path and also because of compliance issues. The active branch contains advanced features we will merge after QA and pilot acceptance.




---

Final ask (what we want from judges & partners)

Judges: Invite Integro to the private pitch so we can demo the stable Golden Path live and show advanced HCS/PPSSS features on the active branch if desired.

Telcos / Aggregators: Pilot the USSD flow with a small user base for 30 days.

Microfinance partners: Pilot collateral acceptance for RWA NFTs to test loan conversion and liquidity unlocking.



---

Contact & credits

Project Lead / contact: Dayo Ogunlana

Live app: https://integro-hed.netlify.app

Demo video: https://youtu.be/g0xtMrfzN9U?si=MeBhpT89FnLRyC3m


*Hedera aims to build the trust layer for the global digital economy. Integro can be the tool employed in building the trust layer for Africa's Informal Economy.*



