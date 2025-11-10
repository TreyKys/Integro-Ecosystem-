## Manual Testing Instructions

To test the new DID anchoring functionality, follow these steps:

1.  **Deploy the `createAccount` function:**
    - Deploy the updated `createAccount` Firebase function to your development environment.

2.  **Call the `createAccount` function:**
    - Send a POST request to the `createAccount` function endpoint. You can use a tool like `curl` or Postman.
    - Example using `curl`:
      ```bash
      curl -X POST <YOUR_FUNCTION_URL>/createAccount
      ```

3.  **Verify the response:**
    - The response JSON should now include a `did` and a `didAnchor` object.
    - Example response:
      ```json
      {
        "accountId": "0.0.12345",
        "privateKey": "0x...",
        "evmAddress": "0x...",
        "did": "did:integro:...",
        "didAnchor": {
          "topicId": "0.0.67890",
          "transactionId": "...",
          "consensusTimestamp": "..."
        }
      }
      ```

4.  **Verify the Firestore document:**
    - Go to your Firestore database and check the `dids` collection.
    - There should be a new document with the ID matching the `did` from the response.
    - The document should contain the `doc`, `accountId`, `evmAddress`, and `anchored` fields.

5.  **Verify the HCS message on Hashscan:**
    - Go to [Hashscan](https://hashscan.io/).
    - In the search bar, enter the `topicId` from the `didAnchor` object in the response.
    - You should see a recent transaction with the `transactionId` from the `didAnchor` object.
    - The message in the transaction should be the SHA256 hash of the DID document.
