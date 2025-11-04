import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context()
        page = await context.new_page()

        await page.goto("http://localhost:5178")

        # Click the create vault button
        await page.click("text=Create Your Secure Vault")

        # Wait for navigation to the profile setup page
        await page.wait_for_url("**/profile-setup")

        # Retrieve the credentials from local storage
        private_key = await page.evaluate("localStorage.getItem('integro-private-key')")
        account_id = await page.evaluate("localStorage.getItem('integro-account-id')")
        evm_address = await page.evaluate("localStorage.getItem('integro-evm-address')")

        print(f"SELLER_PRIVATE_KEY={private_key}")
        print(f"SELLER_ACCOUNT_ID={account_id}")
        print(f"SELLER_EVM_ADDRESS={evm_address}")

        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())
