🪙 Project Integro

Project Track: DLT for Operations
This is the main repository for the Integro Ecosystem — our TRL 4-6 (Working Prototype) submission for the Hedera Africa Hackathon.


---

Key Project Links

Live Web App (TRL 4-6 Demo): https://integro-hed.netlify.app

Demo Video (Required): https://youtube.com/shorts/g0xtMrfzN9U?si=T2akZGlA35cZk6WL

Pitch Deck (Required): https://docs.google.com/presentation/d/1odNrYgbW6caQov2oztkxDawTvbzmURmCN2XT4r5bkGI/edit?usp=drivesdk

Hedera Certification (Required): View our On-Chain Certification NFT


> (Note: per submission guidelines the account Hackathon@hashgraph-association.com has been invited as collaborator.)




---

1. Our Vision: Integrity & Growth

Our mission is to integrate Africa’s fragmented, $3 trillion informal economy into a single, whole ecosystem.

Integrity: Build trust via a decentralized Trust Engine (Identity, Reputation, Escrow).

Growth: Unlock economic opportunity via three arms — Marketplace, Finance (Lending), and Logistics.



---

2. The Problem We Solve

The informal economy is trapped by two barriers:

Integrity Gap: no verifiable identity, no proof of asset quality, no secure payment settlement.

Digital Divide: most solutions ignore the ~85% of users on feature phones — a major access gap that blocks finance and markets.



---

3. What Integro Is & TRL Status

We are honest about what’s built and what’s in progress.

TRL 4–6 (Working Prototype — Stable branch / deployed demo)

The stable branch demonstrates a single, reliable golden path suitable for a live demo.

Core live components (stable branch):

Account Factory — createAccount (server): creates non-custodial Hedera accounts and returns client keys for the demo.

RWA NFT Minting — mintRWAviaUSSD (server): mints the IVA-NFT and transfers serials to users.

Listing & Market — frontend marketplace UI shows minted assets.

Escrow & Settlement — fundEscrow and confirmDelivery execute on-chain with the deployed escrow contract.


IDs used in stable demo

Integro Verified Asset (IVA-NFT) Token ID: 0.0.7134449

Escrow Contract ID (stable demo): 0.0.7182623


> Important: the stable demo does not use PPSSS (PIN signer) or HCS anchoring — those are in the active development branch. The stable branch is deliberately minimal and reliable for demoing the golden path.



TRL 1–3 (Vision / roadmap)

Finance arm (Lending Pool): architecture ready; smart contracts not yet deployed.

Logistics arm (Agent staking, SBTs): UI scaffolding ready; staking/slashing contracts are roadmapped.



---

4. The USSD Simulator — Vision vs Reality

Our killer accessibility feature is the USSD/SMS bridge for feature phones.

We built the backend USSD-ready functions (createAccount, mintRWAviaUSSD, etc.) so the full Golden Path can be executed via USSD.

The stable demo intentionally shows the web app golden path (more reliable for judges). The USSD simulator UI had state-management issues that would have made live demo flaky — the backend is production-ready; the front-end USSD simulator is in active dev.



---

5. Technical Architecture (high level)

```
graph TD
    subgraph "User Interface (TRL 4-6)"
        WebApp[React Web App]
        USSDSim[USSD Simulator UI]
    end
    subgraph "Backend Logic (Serverless)"
        FirebaseFns[Firebase Cloud Functions]
    end
    subgraph "Data & State"
        Firestore[Firestore Database]
    end
    subgraph "Hedera DLT (Source of Truth)"
        HAS[Hedera Account Service]
        HTS[Hedera Token Service]
        HSCS[Hedera Smart Contract Service]
        HCS[Hedera Consensus Service - active branch]
    end
    WebApp -- HTTPS Call --> FirebaseFns
    USSDSim -- HTTPS Call --> FirebaseFns
    FirebaseFns -- Creates/Reads/Updates --> Firestore
    FirebaseFns -- Submits Transactions --> HAS
    FirebaseFns -- Submits Transactions --> HTS
    FirebaseFns -- Submits Transactions --> HSCS
    FirebaseFns -- (active) Submits Anchors --> HCS
    Firestore -- Mirrors On-Chain State --> WebApp
    Firestore -- Mirrors On-Chain State --> USSDSim
    HAS -- Creates --> UserAccount[User 0.0.X Account]
    HTS -- Mints --> NFT[IVA-NFT]
    HSCS -- Manages --> Escrow[Escrow.sol Contract]
    HCS -- Anchors --> DID[Identity / Events]
    UserAccount -- Owns --> NFT
    UserAccount -- Interacts with --> Escrow
```

A note on keys & non-custodial design

Our createAccount returns generated private key material to the client as part of the non-custodial demo. In a production mobile app the private key would be stored in the device keychain. For the demo we intentionally keep keys client-side to show ownership and signing flows.


Security & deployment: DO NOT commit private keys to the repo. Put them in /functions/.env locally or in your Firebase secrets. (See Deployment section below.)


---

6. Active development branch (what’s being built now — not present in stable demo)

This is the powerful, innovation layer that extends the golden path into a robust Trust Engine.

Key features in the active branch:

PPSSS (PIN-based remote signer): a PIN Signer model so USSD users can authenticate and sign sensitive flows without exposing private keys. Backend holds a PIN signer key in secure env; users authenticate with a PIN that authorizes the signer for a single action.

HCS Anchoring (Audit trail): every major state change (ListingCreated, ListingVerified, EscrowFunded, DeliveryConfirmed, AgentCreated) is anchored to an HCS topic for an immutable public audit trail and DID verifiability.

DID Integration: DID creation & anchoring flow: accounts/listings/agent claims are anchored with DID-style records (HCS + on-chain hashes) so identity & events are verifiable off-chain.

Agent Onboarding & Dashboard: agents are web-only actors who claim, verify, and mint listings. The agent dashboard shows pending listings and verification controls.

Agent Claim & Verify flows: claimListing → verifyListing — these calls mint RWA SBTs/NFTs as part of verification, update Firestore, and push anchors to HCS.

Automated fallbacks: auto-confirmation 24 hours after delivery if buyer doesn't act (configurable safety net).

Delivery gig creation & tracking: delivery assignments are created when buyNow completes; delivery agent confirms via web dashboard; this triggers confirmDelivery flows.


These active-branch features are under development and will be merged once stably tested. You can find them in the active branch.


---

7. The Golden Path (stable branch — exactly what you can demo)

1. createAccount (serverless function) → creates a Hedera account and returns private key to client (demo-only).


2. mintRWAviaUSSD (server) → mints an IVA-NFT (HTS) and transfers NFT serial to seller.


3. Seller lists asset on web app → Firestore listing created.


4. Buyer funds escrow by calling fundEscrow on the escrow contract (0.0.7182623) — buyer signs with their client key.


5. Delivery & confirmDelivery → buyer calls confirmDelivery (client-signed). Backend runs executeNativeNftTransfer to transfer NFT serial to buyer and release funds.



Demo verification checklist (short):

Check createAccount returned account ID and private key.

Check HashScan for token mint (token 0.0.7134449) and transfer serial.

Check Firestore listings/{listingId} and purchases/{purchaseId} state transitions.

Check fundEscrow and confirmDelivery transactions on HashScan for 0.0.7182623.



---

8. Hedera SDK transactions used (stable & active references)

Use these SDK classes in your functions (examples are representative patterns):

AccountCreateTransaction → create accounts

TokenMintTransaction → mint NFT metadata + serials

TransferTransaction → transfer NFT serials (addNftTransfer)

AccountAllowanceApproveTransaction → approve token/NFT allowances (if using allowance flow)

ContractExecuteTransaction + ContractFunctionParameters → call fundEscrow, confirmDelivery on HSCS contract (0.0.7182623)

TopicCreateTransaction, TopicMessageSubmitTransaction → create HCS anchors (active branch)

FileCreateTransaction / FileAppendTransaction → HFS metadata uploads (if used)


Pattern reminders: .freezeWith(client) before .sign() for multi-signer flows; always call .getReceipt(client) after .execute(client).


---

9. Why Integro is a game changer (concise & hard-hitting)

Accessible by design: built from day one to include feature-phone users via a USSD bridge — that unlocks massive volumes of previously excluded economic activity.

Native Hedera integration: HTS + HSCS + (active) HCS create a tamper-evident, performant commercial loop for low-margin, high-frequency trades. Hedera’s cheap, predictable fees make micro-transactions economically feasible.

Non-custodial ownership: the Account Factory proves a real seedless wallet flow suitable for mass onboarding without forcing users to pre-provision wallets.

Verifiable Trust Engine: agent verification, HCS anchoring, and future SBT reputation combine to create a verifiable reputation layer that lenders and buyers can trust — this is the core infrastructure that makes informal market creditable.

Actionable business impact: reduces fraud, opens liquidity for smallholders (tokenizable RWAs), and lowers settlement friction — all key to unlocking billions in value across African informal markets.



---

10. How to run (dev & deploy)

Prerequisites

Node.js (v18+), npm

Firebase CLI (npm i -g firebase-tools)


Install

git clone https://github.com/Hashgraph-Association/DLT-Operations-Track-Submission-Integro.git
cd DLT-Operations-Track-Submission-Integro

npm install --prefix skillswap-react
npm install --prefix skillswap-contracts
npm install --prefix functions

Environment variables (secure: DO NOT COMMIT)

Create /functions/.env and add the following (example — do not paste secret values in repo):

# Hedera admin (for server-side actions). Set these locally in your environment only.
HEDERA_ADMIN_ACCOUNT_ID="0.0.xxxxx"
HEDERA_ADMIN_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"

# Admin supply key for the IVA-NFT (used by mintRWAviaUSSD)
HEDERA_ADMIN_SUPPLY_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"

# PPSSS / PIN Signer keys (active branch only — keep secret)
PIN_SIGNER_PRIVATE_KEY="..."
PIN_SIGNER_ACCOUNT_ID="0.0.xxxxx"

Important: paste your real private key(s) locally into /functions/.env or into Firebase Secrets via the Firebase console. Do not commit them to Git.

Run the frontend locally

npm run dev --prefix skillswap-react
# Open http://localhost:5173

Deploy functions

npx firebase login
npx firebase use <your-project-id>
npx firebase deploy --only functions


---

11. All Currently Deployed IDs (First 4 for stable demo)

IVA-NFT Token ID: 0.0.7134449

Escrow Contract ID: 0.0.7182623


Cloud functions (example endpoints):

Function URL (createAccount (us-central1)):
https://createaccount-cehqwvb4aq-uc.a.run.app

Function URL (executeNativeNftTransfer (us-central1)):
https://executenativenfttransfer-cehqwvb4aq-uc.a.run.app

Function URL (mintRWAviaUSSD (us-central1)):
https://mintrwaviaussd-cehqwvb4aq-uc.a.run.app

Function URL (setUserProfile (us-central1)):
https://setuserprofile-cehqwvb4aq-uc.a.run.app

Function URL (claimListing (us-central1)):
https://us-central1-integro-ecosystem.cloudfunctions.net/claimListing

Function URL (verifyListing (us-central1)):
https://us-central1-integro-ecosystem.cloudfunctions.net/verifyListing

Function URL (setPin (us-central1)):
https://setpin-cehqwvb4aq-uc.a.run.app

Function URL (signWithPin (us-central1)):
https://signwithpin-cehqwvb4aq-uc.a.run.app

Function URL (revokePin (us-central1)):
https://revokepin-cehqwvb4aq-uc.a.run.app

Function URL (getSignLog (us-central1)):
https://getsignlog-cehqwvb4aq-uc.a.run.app

Function URL (createPendingListing (us-central1)):
https://creatependinglisting-cehqwvb4aq-uc.a.run.app



---

12. Tests & smoke checks (quick)

createAccount succeeds → check account on HashScan.

mintRWAviaUSSD → check token 0.0.7134449 → serial minted & transferred.

Create listing in web UI → Firestore listings entry present.

fundEscrow (buyer signs) → check fundEscrow tx on HashScan for 0.0.7182623.

confirmDelivery → check NFT transfer on HashScan; Firestore purchase state: SOLD.



---

13. Roadmap (what’s next)

Merge active branch: PPSSS, HCS anchoring, DID integration, claim/verify agent flows.

Lending Pool: deploy lending contracts and integrate SBT reputation.

Telco integration: pilot USSD with partner telco for country-level rollouts.

Security & hardening: auditing, secrets management (KMS), doxxed testnet admin rotation.



---

14. Final note

Do not commit private keys. Ever. Put them in /functions/.env locally or in a secret store (Firebase / Cloud).
The stable branch is intentionally minimal and reliable for demos. The active branch contains the Trust Engine and advanced features (PPSSS, HCS anchoring, DID) and will be merged once fully tested.


---

Hedera Certification (image)

https://i.postimg.cc/BbJYZ1j9/205e97fd-e799-4d51-a82f-c0b09a53aa4d-1.png

