import asyncio
from playwright.async_api import async_playwright
import os
import uuid
import time
import requests
from dotenv import load_dotenv

# Load environment variables from the correct .env file
load_dotenv(dotenv_path='skillswap-react/.env')

# --- Hedera Config ---
ASSET_TOKEN_ID = "0.0.7134449"

# --- Seller/Buyer Credentials (Using one account for the whole flow) ---
TEST_ACCOUNT_PRIVATE_KEY = "0x86dd7489545e334d40ba8ef18cde03981608c233a8136d9eb572ab709348bb88"
TEST_ACCOUNT_ID = "0.0.7189748"
TEST_ACCOUNT_EVM_ADDRESS = "0x91Ee3b0feA33fad378D6d3AaF93314E2ccFd45aB"


async def verify_nft_ownership(buyer_account_id, serial_number, retries=15, delay=6):
    """
    Verifies that the buyer owns the NFT by repeatedly querying the Hedera Mirror Node.
    """
    print(f"\n--- Verifying NFT Ownership ---")
    print(f"Checking if Account ID {buyer_account_id} owns NFT {ASSET_TOKEN_ID} with Serial {serial_number}")
    print(f"This will take up to {retries * delay} seconds...")

    mirror_node_url = f"https://testnet.mirrornode.hedera.com/api/v1/accounts/{buyer_account_id}/nfts?token.id={ASSET_TOKEN_ID}"

    for i in range(retries):
        try:
            response = requests.get(mirror_node_url, timeout=10)
            if response.status_code == 404:
                print(f"Attempt {i + 1}/{retries}: Account {buyer_account_id} not yet found on mirror node. Retrying...")
                await asyncio.sleep(delay)
                continue

            response.raise_for_status()
            data = response.json()

            nfts = data.get('nfts', [])
            for nft in nfts:
                if nft.get('serial_number') == serial_number:
                    print(f"✅ SUCCESS: NFT with serial {serial_number} found in buyer's account.")
                    return True

            print(f"Attempt {i + 1}/{retries}: NFT not found yet in account. Current NFTs: {[nft.get('serial_number') for nft in nfts]}. Retrying...")
            await asyncio.sleep(delay)

        except requests.exceptions.RequestException as e:
            print(f"Attempt {i + 1}/{retries}: Error querying Mirror Node: {e}. Retrying...")
            await asyncio.sleep(delay)

    print(f"❌ FAILURE: Could not verify NFT ownership after {retries} attempts.")
    return False

async def set_auth_keys(page, private_key, account_id, evm_address):
    """Sets authentication keys in local storage to simulate login."""
    await page.goto("http://localhost:5173") # Go to a page to set the context
    await page.evaluate(f"localStorage.setItem('integro-private-key', '{private_key}')")
    await page.evaluate(f"localStorage.setItem('integro-account-id', '{account_id}')")
    await page.evaluate(f"localStorage.setItem('integro-evm-address', '{evm_address}')")
    print(f"--- Logged in as: {account_id} ---")

async def main():
    # Verify that the environment variable is accessible to this script
    admin_private_key = os.getenv("VITE_ADMIN_PRIVATE_KEY")
    if not admin_private_key:
        raise ValueError("VITE_ADMIN_PRIVATE_KEY not found in skillswap-react/.env file. Please ensure it's set.")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context()
        page = await context.new_page()

        # Capture and print all browser console logs
        page.on("console", lambda msg: print(f"BROWSER LOG: {msg.text}"))

        # --- STEP 1: Login and List an Asset ---
        print("--- Logging in as Seller ---")
        await set_auth_keys(page, TEST_ACCOUNT_PRIVATE_KEY, TEST_ACCOUNT_ID, TEST_ACCOUNT_EVM_ADDRESS)
        await page.goto("http://localhost:5173/create-listing")

        await page.wait_for_selector("h2:has-text('Create a New Listing')")
        print("--- Create Listing page loaded ---")

        asset_name = f"Self-Purchase Test {uuid.uuid4().hex[:6]}"
        asset_category = "Services & Gigs"
        print(f"--- Listing new asset: '{asset_name}' ---")
        await page.fill('#name', asset_name)
        await page.fill('#description', "An automated test service for verification.")
        await page.fill('#price', "1.2") # Use a small amount
        await page.select_option('#category', asset_category)
        await page.fill('#imageUrl', "https://i.postimg.cc/6pz0BVBv/Gemini-Generated-Image-pynbzgpynbzgpynb-2.jpg")

        await page.get_by_role("button", name="Create Listing").click()

        await page.wait_for_selector("text=✅ Asset listed successfully!", timeout=120000)
        print("--- Asset listed successfully ---")

        # --- STEP 2: As the same user, buy the asset ---
        print("\n--- Navigating to Marketplace to buy own asset ---")
        await page.goto("http://localhost:5173/marketplace")
        await page.wait_for_url("**/marketplace", timeout=60000)

        print(f"--- Finding and buying asset: '{asset_name}' ---")
        listing_card_locator = page.locator(f".listing-card:has-text('{asset_name}')")
        await listing_card_locator.wait_for(state="visible", timeout=30000)

        await listing_card_locator.get_by_role("button", name="Buy Now").click()

        await page.get_by_role("button", name="Confirm").click()

        await page.wait_for_selector("text=Congratulations! You have purchased", timeout=120000)
        print("--- Asset purchased successfully ---")

        # --- STEP 3: Confirm Delivery and Verify On-Chain ---
        await page.goto("http://localhost:5173/my-assets")
        await page.wait_for_url("**/my-assets", timeout=60000)
        print("--- Navigated to My Assets page ---")

        asset_card_locator = page.locator(f".asset-card:has-text('{asset_name}')")
        await asset_card_locator.wait_for(state="visible", timeout=30000)
        print("--- Purchased asset found on My Assets page ---")

        serial_text = await asset_card_locator.locator(".asset-serial").inner_text()
        serial_number = int(serial_text.split(':')[1].strip())
        print(f"--- Extracted serial number: {serial_number} ---")

        await asset_card_locator.get_by_role("button", name="Confirm Delivery").click()
        print("--- 'Confirm Delivery' button clicked. Waiting for on-chain verification... ---")

        # In this flow, the "buyer" is the original owner. So we check if they still own the NFT.
        ownership_verified = await verify_nft_ownership(TEST_ACCOUNT_ID, serial_number)

        if not ownership_verified:
            await page.screenshot(path="test_failure.png")
            raise Exception("On-chain verification failed! Check BROWSER LOGS and screenshot.")

        print("\n\n✅✅✅ E2E TEST SUCCEEDED (ON-CHAIN VERIFIED) ✅✅✅")
        await page.screenshot(path="final_state.png")
        await browser.close()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        print(f"\n\n❌❌❌ E2E TEST FAILED: {e} ❌❌❌")
        # Exit with a non-zero code to indicate failure for CI/CD systems
        exit(1)
