import asyncio
from playwright.async_api import async_playwright
import os
import uuid
import time
import requests
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv(dotenv_path='skillswap-react/.env')

# --- Hedera Config ---
ASSET_TOKEN_ID = "0.0.7134449"

# --- Seller Credentials ---
SELLER_PRIVATE_KEY = "0x86dd7489545e334d40ba8ef18cde03981608c233a8136d9eb572ab709348bb88"
SELLER_ACCOUNT_ID = "0.0.7189748"
SELLER_EVM_ADDRESS = "0x91Ee3b0feA33fad378D6d3AaF93314E2ccFd45aB"


async def verify_nft_ownership(buyer_account_id, serial_number, retries=10, delay=5):
    """
    Verifies that the buyer owns the NFT by querying the Hedera Mirror Node.
    """
    print(f"\n--- Verifying NFT Ownership ---")
    print(f"Checking if Account ID {buyer_account_id} owns NFT {ASSET_TOKEN_ID} with Serial {serial_number}")

    mirror_node_url = f"https://testnet.mirrornode.hedera.com/api/v1/accounts/{buyer_account_id}/nfts?token.id={ASSET_TOKEN_ID}"

    for i in range(retries):
        try:
            response = requests.get(mirror_node_url)
            response.raise_for_status()
            data = response.json()

            nfts = data.get('nfts', [])
            for nft in nfts:
                if nft.get('serial_number') == serial_number:
                    print(f"✅ SUCCESS: NFT with serial {serial_number} found in buyer's account.")
                    return True

            print(f"Attempt {i + 1}/{retries}: NFT not found yet. Retrying in {delay} seconds...")
            await asyncio.sleep(delay)

        except requests.exceptions.RequestException as e:
            print(f"Attempt {i + 1}/{retries}: Error querying Mirror Node: {e}. Retrying in {delay} seconds...")
            await asyncio.sleep(delay)

    print(f"❌ FAILURE: Could not verify NFT ownership after {retries} attempts.")
    return False


async def create_new_account(page):
    """Navigates to landing and creates a new account, returns credentials."""
    await page.goto("http://localhost:5173")
    await page.click("text=Create Your Secure Vault")
    await page.wait_for_url("**/profile-setup", timeout=60000)

    private_key = await page.evaluate("localStorage.getItem('integro-private-key')")
    account_id = await page.evaluate("localStorage.getItem('integro-account-id')")
    evm_address = await page.evaluate("localStorage.getItem('integro-evm-address')")

    return {"private_key": private_key, "account_id": account_id, "evm_address": evm_address}

async def set_auth_keys(page, private_key, account_id, evm_address):
    """Sets authentication keys in local storage."""
    await page.goto("http://localhost:5173")
    await page.evaluate(f"localStorage.setItem('integro-private-key', '{private_key}')")
    await page.evaluate(f"localStorage.setItem('integro-account-id', '{account_id}')")
    await page.evaluate(f"localStorage.setItem('integro-evm-address', '{evm_address}')")

async def logout(page):
    """Clears authentication keys from local storage."""
    print("--- Logging out ---")
    await page.goto("http://localhost:5173")
    await page.evaluate("localStorage.removeItem('integro-private-key')")
    await page.evaluate("localStorage.removeItem('integro-account-id')")
    await page.evaluate("localStorage.removeItem('integro-evm-address')")
    await page.reload()

async def main():
    admin_private_key = os.getenv("REACT_APP_ADMIN_PRIVATE_KEY")
    if not admin_private_key:
        raise ValueError("REACT_APP_ADMIN_PRIVATE_KEY not found in .env file.")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context()
        page = await context.new_page()

        # Capture and print all console logs
        page.on("console", lambda msg: print(f"BROWSER LOG: {msg.text}"))

        await page.add_init_script(f"window.REACT_APP_ADMIN_PRIVATE_KEY = '{admin_private_key}';")

        # 1. Login as Seller and List an Asset
        print("--- Logging in as Seller ---")
        await set_auth_keys(page, SELLER_PRIVATE_KEY, SELLER_ACCOUNT_ID, SELLER_EVM_ADDRESS)
        await page.goto("http://localhost:5173/create-listing")

        await page.wait_for_selector("h2:has-text('Create a New Listing')")
        print("--- Create Listing page loaded ---")

        print("--- Filling out listing form ---")
        asset_name = f"Test Service {uuid.uuid4()}"
        asset_category = "Services & Gigs"
        await page.fill('#name', asset_name)
        await page.fill('#description', "A test service for verification.")
        await page.fill('#price', "2.5")
        await page.select_option('#category', asset_category)
        await page.fill('#imageUrl', "https://i.postimg.cc/6pz0BVBv/Gemini-Generated-Image-pynbzgpynbzgpynb-2.jpg")

        await page.click("button:has-text('Create Listing')")

        await page.wait_for_selector("text=✅ Asset listed successfully!", timeout=90000)
        print(f"Asset '{asset_name}' listed successfully in category '{asset_category}'.")

        await logout(page)

        # 2. Create a Buyer Account
        print("\n--- Creating Buyer Account ---")
        buyer_credentials = await create_new_account(page)
        print(f"Buyer account created: {buyer_credentials['account_id']}")

        # 3. Login as Buyer and Buy the Asset
        print("\n--- Logging in as Buyer ---")
        await page.goto("http://localhost:5173/marketplace")

        print(f"--- Selecting category '{asset_category}' ---")
        await page.click(f".tab:has-text('{asset_category}')")

        print(f"--- Waiting for and buying Asset: {asset_name} ---")
        listing_selector = f".listing-card:has-text('{asset_name}')"
        await page.wait_for_selector(listing_selector, timeout=30000)

        listing_locator = page.locator(listing_selector)
        await listing_locator.locator("text=Buy Now").click()

        await page.click("button:has-text('Confirm')")

        await page.wait_for_selector("text=Congratulations! You have purchased", timeout=90000)
        print("Asset purchased successfully.")

        # 4. Confirm Delivery and Verify On-Chain
        print("\n--- Confirming Delivery ---")
        await page.goto("http://localhost:5173/my-assets")

        asset_locator = page.locator(f".asset-card:has-text('{asset_name}')")
        await asset_locator.wait_for(state="visible", timeout=30000)

        serial_text = await asset_locator.locator(".asset-serial").inner_text()
        serial_number = int(serial_text.split(':')[1].strip())
        print(f"Extracted serial number: {serial_number}")

        await asset_locator.locator("text=Confirm Delivery").click()
        print("'Confirm Delivery' button clicked. Waiting for transaction to propagate...")

        await asyncio.sleep(15) # Increase wait time for logs to appear

        ownership_verified = await verify_nft_ownership(buyer_credentials['account_id'], serial_number)

        if not ownership_verified:
            raise Exception("On-chain verification failed! Check BROWSER LOGS for errors.")

        print("\n\n✅✅✅ E2E TEST SUCCEEDED (ON-CHAIN VERIFIED) ✅✅✅")

        await page.screenshot(path="final_state.png")
        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())
