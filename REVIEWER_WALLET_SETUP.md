# Reviewer wallet setup

For a group review on the local Hardhat chain. Reviewers use MetaMask on their
phones and sign real transactions, but only on your machine's chain. Nothing goes
to a public network, and the ETH is not worth anything.

## Before the session (host)

1. Start the stack: postgres, redis, `avelon_llm`, `npm run chain:local`,
   `npm run demo:reset`, and `npm run dev`.
2. Start the tunnel: `ngrok http 3001 --url=unstated-lennie-steellike.ngrok-free.dev`
3. Fund the pool. An empty pool makes every approval fail. Either:
   - deposit from an investor account in the app, or
   - run `npx tsx scripts/demo-drive-loan.ts <email>` on a pending loan, which tops the
     pool up itself.
4. Check the chain is reachable through the tunnel:

   ```bash
   curl -s -X POST -H 'content-type: application/json' \
     --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' \
     https://unstated-lennie-steellike.ngrok-free.dev/api/v1/rpc
   # {"jsonrpc":"2.0","id":1,"result":"0x7a69"}
   ```

5. `.env` should have `TRUSTED_PROXY_COUNT=1` and `RATE_LIMIT_GLOBAL_MAX=1500`.
   Otherwise the whole room shares one 100-request limit.

**Don't restart the Hardhat node during the session.** A restart wipes the chain.
If it happens anyway:
- Re-run `demo:reset`, restart the backend, and fund the pool again.
- Every reviewer must clear MetaMask's cached nonces: Settings → Advanced →
  Clear activity tab data.

## Accounts to hand out

These are Hardhat's built-in test accounts. Their keys are published in Hardhat's
own docs, so anyone can use them. **Never send real funds to these addresses.**
Each account starts with 10,000 ETH on the local chain.

| # | Address | Private key |
|---|---|---|
| 7 | `0x14dC79964da2C08b23698B3D3cc7Ca32193d9955` | `0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356` |
| 8 | `0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f` | `0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97` |
| 9 | `0xa0Ee7A142d267C1f36714E4a8F75612F20a79720` | `0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6` |

Accounts #1–#4 belong to the seeded users, #5 to borrower2@gmail.com, and #6 to
wianbarillo@gmail.com. A wallet can only be linked to one Avelon user, so give each
reviewer a different account.

## Reviewer steps (on the phone)

1. **Add the network in MetaMask.** Networks → Add network → Add a network manually:
   - Network name: `Avelon Local`
   - RPC URL: `https://unstated-lennie-steellike.ngrok-free.dev/api/v1/rpc`
   - Chain ID: `31337`
   - Currency symbol: `ETH`

   MetaMask may warn that the chain ID belongs to "Localhost". That's expected, so
   save it anyway.
2. **Import the account.** Account menu → Add account → Private key, then paste the
   key you were given. Switch to Avelon Local, where the balance should read
   10,000 ETH.
3. **Open Avelon and log in** (or register and finish KYC).
4. **Link the wallet.** Wallet tab → Connect Wallet → MetaMask. Approve the
   connection, then approve the signature request. Wait until Avelon shows the
   address as verified.
5. **Apply for a loan.** Pick a plan your credit score allows; a new borrower gets
   Starter (0.01–0.1 ETH).
6. **Wait for approval.** The host approves it, either in the admin dashboard or
   with `demo-drive-loan.ts`.
7. **Deposit collateral.** Open the loan → Deposit Collateral → approve the
   transaction in MetaMask. Once it confirms, the loan becomes active and the
   principal arrives in the wallet.
8. **Repay** from the loan screen whenever you like. It's another MetaMask
   transaction.

## If something goes wrong

| Symptom | Check |
|---|---|
| MetaMask opens but no connection prompt appears | The Reown project must allowlist `com.avelon.app`, `host.exp.Exponent` and `host.exp.exponent` (cloud.reown.com → project → allowlist) |
| "No Wallet Connected" when applying | The wallet was never verified for this user. Redo step 4 |
| Transaction stuck or "nonce too high" | The chain was restarted. Clear activity tab data in MetaMask |
| "Too many requests" | Raise `RATE_LIMIT_GLOBAL_MAX` and restart the backend |
| Approval fails | The pool is empty. See host step 3 |
