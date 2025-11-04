# Firebase Functions for USSD Bridge

This document provides instructions for deploying and testing the USSD bridge Firebase Functions.

## Deployment

### Secrets

The following secrets must be set in the Firebase project for the functions to work correctly.

```bash
firebase functions:secrets:set HEDERA_ADMIN_ACCOUNT_ID
firebase functions:secrets:set HEDERA_ADMIN_PRIVATE_KEY
firebase functions:secrets:set HEDERA_ADMIN_SUPPLY_KEY
```

### Deploy Command

To deploy the functions, run the following command from the root of the repository:

```bash
firebase deploy --only functions
```

## Testing

You can test the deployed functions using `curl`. Replace `REGION-PROJECT` with your Firebase project's region and project ID.

### Create Vault

```bash
curl -X POST "https://REGION-PROJECT.cloudfunctions.net/createVaultViaUSSD" -H "Content-Type: application/json" -d '{}'
```

### Mint RWA (for testing purposes)

```bash
curl -X POST "https://REGION-PROJECT.cloudfunctions.net/mintRWAviaUSSD" \
  -H "Content-Type: application/json" \
  -d '{"accountId":"0.0.x","assetType":"Test Asset","quality":"A","location":"Test Location"}'
```

### List Product

```bash
curl -X POST "https://REGION-PROJECT.cloudfunctions.net/listProductFromUSSD" \
  -H "Content-Type: application/json" \
  -d '{"sellerAccountId":"0.0.x","sellerPrivateKey":"0x...","productName":"Yam","price":12.5,"description":"Grade A"}'
```

### Fund Escrow

```bash
curl -X POST "https://REGION-PROJECT.cloudfunctions.net/fundEscrowFromUSSD" \
  -H "Content-Type: application/json" \
  -d '{"buyerAccountId":"0.0.y","buyerPrivateKey":"0x...","listingId":"0.0.7134449-1","amount":12.5}'
```

### Confirm Delivery

```bash
curl -X POST "https://REGION-PROJECT.cloudfunctions.net/confirmDeliveryFromUSSD" \
  -H "Content-Type: application/json" \
  -d '{"buyerAccountId":"0.0.y","buyerPrivateKey":"0x...","listingId":"0.0.7134449-1"}'
```
