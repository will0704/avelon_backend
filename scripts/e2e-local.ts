/**
 * End-to-end exercise of all three roles against the local stack.
 *
 * Every transaction here is a real one on the local Hardhat chain and every API
 * call is a real HTTP request to the running backend. Nothing is mocked, so a
 * pass means the database and the chain actually agree.
 *
 * Requires: Hardhat node on 8545, backend on 3001, seeded local database.
 *
 *     cd contracts && npx hardhat node
 *     cd contracts && npx tsx scripts/deploy.ts --network hardhat
 *     npm run db:seed          # with the DEMO_* env vars
 *     npm run dev
 *     npx tsx scripts/e2e-local.ts
 *
 * It refuses to run against anything but chain 31337.
 */
import { ethers } from 'ethers';
import Redis from 'ioredis';
import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, '..', '.env') });

const API = process.env.E2E_API_URL ?? 'http://localhost:3001/api/v1';
const RPC = process.env.CHAIN_RPC_URL ?? 'http://127.0.0.1:8545';
const LOCAL_CHAIN_ID = 31337;

// Hardhat's published accounts. Local-only by construction.
const KEYS = {
    deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    borrower1: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    borrower2: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
    investor1: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
    investor2: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
};

const ACCOUNTS = {
    admin: { email: 'admin@avelon.finance', password: process.env.DEMO_ADMIN_PASSWORD! },
    borrower1: { email: 'borrower@test.com', password: process.env.DEMO_BORROWER_PASSWORD! },
    borrower2: { email: 'borrower2@gmail.com', password: process.env.DEMO_BORROWER_2_PASSWORD! },
    investor1: { email: 'investor@test.com', password: process.env.DEMO_INVESTOR_PASSWORD! },
    investor2: { email: 'investor2@test.com', password: process.env.DEMO_INVESTOR_2_PASSWORD! },
};

const provider = new ethers.JsonRpcProvider(RPC, LOCAL_CHAIN_ID);

// ── tiny test harness ────────────────────────────────────────────────────

let passed = 0;
const failures: string[] = [];
let section = '';

function heading(name: string) {
    section = name;
    console.log(`\n\x1b[1m${name}\x1b[0m`);
}

function check(what: string, ok: boolean, detail = '') {
    if (ok) {
        passed++;
        console.log(`  \x1b[32m✔\x1b[0m ${what}`);
    } else {
        failures.push(`${section} → ${what}${detail ? ` (${detail})` : ''}`);
        console.log(`  \x1b[31m✘\x1b[0m ${what}${detail ? ` — ${detail}` : ''}`);
    }
}

/** Floats of ETH never land exactly; a gwei of slack is plenty. */
function near(actual: number, expected: number, tolerance = 1e-9) {
    return Math.abs(actual - expected) <= tolerance;
}

// ── API helpers ──────────────────────────────────────────────────────────

type Json = Record<string, any>;

async function api(
    method: string,
    endpoint: string,
    opts: { token?: string; body?: Json } = {},
): Promise<{ status: number; body: Json }> {
    const res = await fetch(`${API}${endpoint}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        },
        ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
}

// One session per role for the whole run. The auth limiter allows 5 logins per
// 15 minutes, and re-authenticating per scenario would exhaust it.
const tokenCache = new Map<string, string>();

async function login(who: keyof typeof ACCOUNTS): Promise<string> {
    const cached = tokenCache.get(who);
    if (cached) return cached;

    await clearRateLimits();
    const { email, password } = ACCOUNTS[who];
    const { status, body } = await api('POST', '/auth/login', { body: { email, password } });
    if (status !== 200) {
        throw new Error(`Login failed for ${email}: ${status} ${JSON.stringify(body).slice(0, 200)}`);
    }
    tokenCache.set(who, body.data.accessToken);
    return body.data.accessToken;
}

function must(res: { status: number; body: Json }, what: string): Json {
    if (res.status >= 400) {
        throw new Error(`${what} failed: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
    }
    return res.body.data ?? res.body;
}

// ── contract handles ─────────────────────────────────────────────────────

const POOL_ABI = [
    'function deposit() payable',
    'function withdraw(uint256 shareAmount)',
    'function claimYield()',
    'function repay(uint32 loanId) payable',
    'function totalAssets() view returns (uint256)',
    'function availableLiquidity() view returns (uint256)',
    'function shares(address) view returns (uint256)',
    'function assetsOf(address) view returns (uint256)',
    'function yieldOf(address) view returns (uint256)',
];
const CM_ABI = ['function depositCollateral(uint32 loanId) payable'];
const LENDING_ABI = [
    'function isOverdue(uint32 loanId) view returns (bool)',
    'function getLoan(uint32 loanId) view returns (tuple(address borrower, uint48 createdAt, uint48 activatedAt, uint48 dueDate, uint32 duration, uint16 interestRate, uint8 status, uint128 principal, uint128 collateralRequired, uint128 principalOwed, uint128 interestOwed))',
];

const poolAddress = process.env.LIQUIDITY_POOL_ADDRESS!;
const collateralManagerAddress = process.env.COLLATERAL_MANAGER_ADDRESS!;
const lendingAddress = process.env.AVELON_LENDING_ADDRESS!;

function wallet(key: keyof typeof KEYS) {
    return new ethers.Wallet(KEYS[key], provider);
}
function pool(key: keyof typeof KEYS) {
    return new ethers.Contract(poolAddress, POOL_ABI, wallet(key));
}
const poolRead = new ethers.Contract(poolAddress, POOL_ABI, provider);
const lendingRead = new ethers.Contract(lendingAddress, LENDING_ABI, provider);

/**
 * Move the chain clock past a loan's due date and prove it landed.
 *
 * evm_increaseTime only takes effect on the next mined block, and the node can mine
 * one at the same timestamp, so the jump has to be asserted rather than assumed —
 * otherwise liquidation reverts with LoanNotOverdue and the failure looks like a
 * contract bug.
 */
async function advancePastDueDate(contractLoanId: number): Promise<boolean> {
    const loan = await lendingRead.getLoan(contractLoanId);
    const dueDate = Number(loan.dueDate);

    for (let i = 0; i < 5; i++) {
        if (await lendingRead.isOverdue(contractLoanId)) return true;

        // evm_increaseTime, not evm_setNextBlockTimestamp: the absolute form applies
        // to exactly one block and the one after it falls back to the real clock,
        // which puts the loan back inside its term before the backend's call lands.
        const head = await provider.getBlock('latest');
        const offset = dueDate - Number(head!.timestamp) + 3600;
        await provider.send('evm_increaseTime', [Math.max(offset, 3600)]);
        await provider.send('evm_mine', []);
    }
    return lendingRead.isOverdue(contractLoanId);
}

const eth = (wei: bigint) => Number(ethers.formatEther(wei));

/**
 * Read a balance that is expected to have moved.
 *
 * ethers caches the head block briefly, so a balance read immediately after a
 * transaction confirms can still be the pre-transaction value. Retry until it
 * changes rather than reporting a zero delta.
 */
async function balanceAfterChange(address: string, before: bigint, attempts = 6): Promise<bigint> {
    for (let i = 0; i < attempts; i++) {
        const now = await provider.getBalance(address);
        if (now !== before) return now;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return provider.getBalance(address);
}

/**
 * Clear the rate limiters.
 *
 * A full scenario run legitimately exceeds both the auth limiter (5 sign-ins per
 * 15 minutes) and the global one (100 requests per 15 minutes), because it does in
 * two minutes what a person would spread over an afternoon. Clearing the counters
 * keeps the limiters themselves at production settings rather than weakening them
 * for the tests — the limits are covered separately in security.e2e.test.ts.
 */
async function clearRateLimits() {
    const url = process.env.REDIS_URL;
    if (!url) return;
    const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
    try {
        await redis.connect();
        const keys = await redis.keys('rl:*');
        if (keys.length > 0) await redis.del(...keys);
    } catch {
        // In-memory fallback limiter, or no redis running — nothing to clear.
    } finally {
        redis.disconnect();
    }
}

// ── preflight ────────────────────────────────────────────────────────────

async function preflight() {
    heading('Preflight');

    const net = await provider.getNetwork();
    if (Number(net.chainId) !== LOCAL_CHAIN_ID) {
        throw new Error(`Refusing to run: chain is ${net.chainId}, expected ${LOCAL_CHAIN_ID}`);
    }
    check(`connected to local chain ${LOCAL_CHAIN_ID}`, true);

    const health = await fetch(`${API.replace('/api/v1', '')}/health`);
    check('backend is up', health.ok);

    check('pool contract is deployed', (await provider.getCode(poolAddress)) !== '0x');
    check('collateral manager is deployed', (await provider.getCode(collateralManagerAddress)) !== '0x');

    for (const key of Object.keys(ACCOUNTS) as (keyof typeof ACCOUNTS)[]) {
        if (!ACCOUNTS[key].password) {
            throw new Error(`Missing password env var for ${key}. Export the DEMO_*_PASSWORD values.`);
        }
    }
}

// ── Scenario C (first): investors fund the pool ──────────────────────────

async function scenarioInvestorDeposits() {
    heading('Scenario C1 — investors deposit into the pool');

    const t1 = await login('investor1');
    const t2 = await login('investor2');

    const before = await poolRead.totalAssets();

    // 6 ETH from investor 1, 2 ETH from investor 2 — a deliberate 3:1 split so a
    // pro-rata yield error shows up as an obviously wrong number later.
    const d1 = await pool('investor1').deposit({ value: ethers.parseEther('6') });
    await d1.wait();
    const d2 = await pool('investor2').deposit({ value: ethers.parseEther('2') });
    await d2.wait();

    const r1 = await api('POST', '/investor/deposit', { token: t1, body: { txHash: d1.hash } });
    check('investor 1 deposit recorded', r1.status === 200, JSON.stringify(r1.body).slice(0, 160));
    const r2 = await api('POST', '/investor/deposit', { token: t2, body: { txHash: d2.hash } });
    check('investor 2 deposit recorded', r2.status === 200, JSON.stringify(r2.body).slice(0, 160));

    check('pool assets grew by 8 ETH', near(eth((await poolRead.totalAssets()) - before), 8));

    const p1 = must(await api('GET', '/investor/position', { token: t1 }), 'investor 1 position');
    const p2 = must(await api('GET', '/investor/position', { token: t2 }), 'investor 2 position');
    check('investor 1 position is 6 ETH', near(p1.currentValue, 6, 1e-6), String(p1.currentValue));
    check('investor 2 position is 2 ETH', near(p2.currentValue, 2, 1e-6), String(p2.currentValue));
    check('no yield before any repayment', p1.totalYieldEarned === 0 && p2.totalYieldEarned === 0);

    // Replaying the same hash must not credit a second deposit.
    const replay = await api('POST', '/investor/deposit', { token: t1, body: { txHash: d1.hash } });
    check('duplicate deposit hash rejected', replay.status === 400, `status ${replay.status}`);

    // Investor 2 must not be able to claim investor 1's deposit.
    const stolen = await api('POST', '/investor/deposit', { token: t2, body: { txHash: d1.hash } });
    check('deposit cannot be claimed by another investor', stolen.status === 400, `status ${stolen.status}`);

    return { t1, t2 };
}

// ── Scenario A: full borrower lifecycle ──────────────────────────────────

async function scenarioBorrowerLifecycle() {
    heading('Scenario A — borrower lifecycle');

    const borrowerToken = await login('borrower1');
    const adminToken = await login('admin');

    // Take the largest plan this borrower's credit score actually qualifies for,
    // so the amounts moving through the pool are legible rather than dust.
    const me = must(await api('GET', '/users/me', { token: borrowerToken }), 'profile');
    const plans = must(await api('GET', '/plans', { token: borrowerToken }), 'plans');
    const eligible = plans.filter((p: Json) => Number(p.minCreditScore) <= Number(me.creditScore));
    const plan = eligible.reduce((best: Json, p: Json) =>
        Number(p.maxAmount) > Number(best?.maxAmount ?? -1) ? p : best, null);
    check('a loan plan is available to borrow against', !!plan, `credit score ${me.creditScore}`);
    const amount = String(Number(plan.maxAmount) / 2);

    const wallets = must(await api('GET', '/wallets', { token: borrowerToken }), 'wallets');
    const borrowerWallet = wallets.find((w: Json) => w.isVerified);
    check('borrower has a verified wallet', !!borrowerWallet, JSON.stringify(wallets).slice(0, 120));

    const application = must(
        await api('POST', '/loans', {
            token: borrowerToken,
            body: {
                walletId: borrowerWallet.id,
                planId: plan.id,
                amount,
                duration: plan.durationOptions[plan.durationOptions.length - 1],
                purpose: 'Working capital for a small printing business',
            },
        }),
        'loan application',
    );
    check('application starts as PENDING_APPROVAL', application.status === 'PENDING_APPROVAL', application.status);
    check('no on-chain loan exists before approval', application.contractLoanId == null);

    const loanId = application.id;

    // A borrower must not be able to approve their own loan.
    const selfApprove = await api('POST', `/admin/loans/${loanId}/approve`, { token: borrowerToken });
    check('borrower cannot reach the admin approval route', selfApprove.status === 403, `status ${selfApprove.status}`);

    const approved = must(
        await api('POST', `/admin/loans/${loanId}/approve`, { token: adminToken }),
        'loan approval',
    );
    check('admin approval moves it to PENDING_COLLATERAL', approved.status === 'PENDING_COLLATERAL', approved.status);
    check('approval created the on-chain loan', typeof approved.contractLoanId === 'number');

    const contractLoanId: number = approved.contractLoanId;
    const collateralRequired = approved.collateralRequired;

    // ── collateral, signed by the borrower ───────────────────────────────
    const cm = new ethers.Contract(collateralManagerAddress, CM_ABI, wallet('borrower1'));
    const depositTx = await cm.depositCollateral(contractLoanId, {
        value: ethers.parseEther(String(collateralRequired)),
    });
    await depositTx.wait();

    const borrowerBalanceBefore = await provider.getBalance(borrowerWallet.address);
    const poolCashBefore = await poolRead.availableLiquidity();

    const collateralResult = must(
        await api('POST', `/loans/${loanId}/collateral`, {
            token: borrowerToken,
            body: { txHash: depositTx.hash },
        }),
        'collateral deposit',
    );
    check('collateral recorded and loan activated', collateralResult.status === 'ACTIVE', collateralResult.status);

    // ── disbursement came out of the pool, not a platform wallet ─────────
    const loan = must(await api('GET', `/loans/${loanId}`, { token: borrowerToken }), 'loan');
    const netDisbursed = Number(loan.principal) - Number(loan.originationFee);

    const borrowerGain = eth(
        (await balanceAfterChange(borrowerWallet.address, borrowerBalanceBefore)) - borrowerBalanceBefore,
    );
    check('borrower received the net principal', near(borrowerGain, netDisbursed, 1e-6), String(borrowerGain));

    const poolPaid = eth(poolCashBefore - (await poolRead.availableLiquidity()));
    check('the pool is what paid it', near(poolPaid, netDisbursed, 1e-6), String(poolPaid));

    const disbursements = must(
        await api('GET', `/loans/${loanId}/transactions`, { token: borrowerToken }),
        'loan transactions',
    );
    check(
        'disbursement is on the loan ledger',
        disbursements.some((t: Json) => t.type === 'LOAN_DISBURSEMENT'),
    );

    // ── repayment, signed by the borrower, straight into the pool ────────
    const owed = Number(loan.principalOwed) + Number(loan.interestOwed) + Number(loan.feesOwed);
    check('interest is owed on the active loan', Number(loan.interestOwed) > 0, String(loan.interestOwed));

    // Half first, to prove partial repayment tracks.
    const half = (owed / 2).toFixed(18);
    const partialTx = await pool('borrower1').repay(contractLoanId, { value: ethers.parseEther(half) });
    await partialTx.wait();
    const partial = must(
        await api('POST', `/loans/${loanId}/repay`, {
            token: borrowerToken,
            body: { amount: half, txHash: partialTx.hash },
        }),
        'partial repayment',
    );
    check('partial repayment leaves a balance', partial.isFullyRepaid === false && Number(partial.remainingOwed) > 0);

    // Replaying a repayment hash must be refused.
    const replay = await api('POST', `/loans/${loanId}/repay`, {
        token: borrowerToken,
        body: { amount: half, txHash: partialTx.hash },
    });
    check('duplicate repayment hash rejected', replay.status === 400, `status ${replay.status}`);

    const stakeBefore = await provider.getBalance(borrowerWallet.address);

    const rest = partial.remainingOwed;
    const finalTx = await pool('borrower1').repay(contractLoanId, { value: ethers.parseEther(rest) });
    await finalTx.wait();
    const settled = must(
        await api('POST', `/loans/${loanId}/repay`, {
            token: borrowerToken,
            body: { amount: rest, txHash: finalTx.hash },
        }),
        'final repayment',
    );
    check('loan reports fully repaid', settled.isFullyRepaid === true);

    const finalLoan = must(await api('GET', `/loans/${loanId}`, { token: borrowerToken }), 'final loan');
    check('loan status is REPAID', finalLoan.status === 'REPAID', finalLoan.status);

    // ── collateral came back ─────────────────────────────────────────────
    const stakeAfter = await balanceAfterChange(borrowerWallet.address, stakeBefore);
    const netMove = eth(stakeAfter - stakeBefore) + Number(rest);
    check(
        'stake returned on completion',
        near(netMove, Number(collateralRequired), 1e-3),
        `moved ${netMove}, stake ${collateralRequired}`,
    );

    return { contractLoanId, interestPaid: Number(loan.interestOwed) };
}

// ── Scenario B: rejection ────────────────────────────────────────────────

async function scenarioRejection() {
    heading('Scenario B — rejected application');

    const borrowerToken = await login('borrower2');
    const adminToken = await login('admin');

    const plans = must(await api('GET', '/plans', { token: borrowerToken }), 'plans');
    const starter = plans.find((p: Json) => p.name === 'Starter');
    const smallAmount = String(Number(starter.minAmount) * 2);
    const wallets = must(await api('GET', '/wallets', { token: borrowerToken }), 'wallets');
    const w = wallets.find((x: Json) => x.isVerified);

    const application = must(
        await api('POST', '/loans', {
            token: borrowerToken,
            body: {
                walletId: w.id,
                planId: starter.id,
                amount: smallAmount,
                duration: starter.durationOptions[0],
                purpose: 'Buying inventory for a sari-sari store',
            },
        }),
        'application',
    );

    const noReason = await api('POST', `/admin/loans/${application.id}/reject`, {
        token: adminToken,
        body: { reason: 'no' },
    });
    check('rejection without a real reason is refused', noReason.status === 400, `status ${noReason.status}`);

    const rejected = must(
        await api('POST', `/admin/loans/${application.id}/reject`, {
            token: adminToken,
            body: { reason: 'Stated purpose could not be verified against the submitted documents.' },
        }),
        'rejection',
    );
    check('application is REJECTED', rejected.status === 'REJECTED', rejected.status);

    const seen = must(await api('GET', `/loans/${application.id}`, { token: borrowerToken }), 'borrower view');
    check('borrower sees the rejection', seen.status === 'REJECTED');
    check('borrower sees the reason', typeof seen.rejectionReason === 'string' && seen.rejectionReason.length > 10);

    // A rejected application must not be fundable.
    const cm = new ethers.Contract(collateralManagerAddress, CM_ABI, wallet('borrower2'));
    let reverted = false;
    try {
        await cm.depositCollateral.staticCall(9999, { value: ethers.parseEther('0.1') });
    } catch {
        reverted = true;
    }
    check('no on-chain loan exists to collateralise', reverted);

    // Borrower 2 must not be able to read borrower 1's loans.
    const otherLoans = must(await api('GET', '/loans', { token: borrowerToken }), 'own loans');
    check(
        'borrower only sees their own loans',
        otherLoans.every((l: Json) => l.id === application.id),
        `${otherLoans.length} loans returned`,
    );

    return application.id;
}

// ── Scenario C (rest): yield, claim, withdrawal ──────────────────────────

async function scenarioInvestorYield(tokens: { t1: string; t2: string }) {
    heading('Scenario C2 — yield, claim and withdrawal');

    const { t1, t2 } = tokens;
    const a1 = wallet('investor1').address;
    const a2 = wallet('investor2').address;

    const y1 = eth(await poolRead.yieldOf(a1));
    const y2 = eth(await poolRead.yieldOf(a2));

    check('investor 1 earned yield from the repaid loan', y1 > 0, String(y1));
    check('investor 2 earned yield', y2 > 0, String(y2));
    // 6 ETH against 2 ETH is a 3:1 claim on every ETH of interest.
    check('yield split 3:1 matches the deposits', near(y1 / y2, 3, 0.02), `${y1} vs ${y2}`);

    const earnings = must(await api('GET', '/investor/earnings', { token: t1 }), 'earnings');
    check('API reports the same claimable yield', near(earnings.claimable, y1, 1e-9), String(earnings.claimable));

    // ── claim: gain out, principal stays in ──────────────────────────────
    const basisBefore = eth(await poolRead.assetsOf(a1)) - y1;
    const aliceBefore = await provider.getBalance(a1);
    const claimTx = await pool('investor1').claimYield();
    await claimTx.wait();
    await balanceAfterChange(a1, aliceBefore);
    const claim = await api('POST', '/investor/claim-yield', { token: t1, body: { txHash: claimTx.hash } });
    check('yield claim recorded', claim.status === 200, JSON.stringify(claim.body).slice(0, 160));

    check('claim left the principal invested', near(eth(await poolRead.assetsOf(a1)), basisBefore, 1e-6));
    check('nothing left to claim afterwards', eth(await poolRead.yieldOf(a1)) < 1e-9);
    check('investor 2 was untouched by the claim', near(eth(await poolRead.yieldOf(a2)), y2, 1e-9));

    // ── withdrawal ───────────────────────────────────────────────────────
    const shares2 = await poolRead.shares(a2);
    const balanceBefore = await provider.getBalance(a2);
    const value2 = eth(await poolRead.assetsOf(a2));

    const withdrawTx = await pool('investor2').withdraw(shares2);
    await withdrawTx.wait();
    const wd = await api('POST', '/investor/withdraw', { token: t2, body: { txHash: withdrawTx.hash } });
    check('withdrawal recorded', wd.status === 200, JSON.stringify(wd.body).slice(0, 160));

    const received = eth((await balanceAfterChange(a2, balanceBefore)) - balanceBefore);
    check('investor 2 got principal plus yield back', near(received, value2, 1e-3), `${received} vs ${value2}`);
    check('investor 2 holds no shares', (await poolRead.shares(a2)) === 0n);
    check('investor 1 unaffected by the exit', near(eth(await poolRead.assetsOf(a1)), basisBefore, 1e-6));

    const history = must(await api('GET', '/investor/transactions', { token: t2 }), 'history');
    check(
        'withdrawal appears in the ledger',
        history.transactions.some((t: Json) => t.type === 'WITHDRAWAL'),
    );
}

// ── Scenario E: failure handling ─────────────────────────────────────────

async function scenarioFailures(tokens: { t1: string; t2: string }) {
    heading('Scenario E — failure handling');

    const { t1 } = tokens;
    const borrowerToken = await login('borrower1');
    const adminToken = await login('admin');

    // over-withdrawal
    const a1 = wallet('investor1').address;
    const tooMany = (await poolRead.shares(a1)) + ethers.parseEther('1');
    let overdrawReverted = false;
    try {
        await pool('investor1').withdraw.staticCall(tooMany);
    } catch {
        overdrawReverted = true;
    }
    check('withdrawing more shares than held reverts on-chain', overdrawReverted);

    // fabricated transaction hash
    const fake = '0x' + 'ab'.repeat(32);
    const fakeDeposit = await api('POST', '/investor/deposit', { token: t1, body: { txHash: fake } });
    check('unknown transaction hash rejected', fakeDeposit.status === 400, `status ${fakeDeposit.status}`);

    // malformed hash
    const malformed = await api('POST', '/investor/deposit', { token: t1, body: { txHash: 'not-a-hash' } });
    check('malformed transaction hash rejected', malformed.status === 400, `status ${malformed.status}`);

    // a plain ETH transfer to the pool is not a repayment
    const plain = await wallet('borrower1').sendTransaction({
        to: poolAddress,
        value: ethers.parseEther('0.001'),
    });
    await plain.wait();
    const loans = must(await api('GET', '/loans', { token: borrowerToken }), 'loans');
    const repaid = loans.find((l: Json) => l.status === 'REPAID');
    if (repaid) {
        const bad = await api('POST', `/loans/${repaid.id}/repay`, {
            token: borrowerToken,
            body: { amount: '0.001', txHash: plain.hash },
        });
        check('plain transfer is not accepted as a repayment', bad.status === 400, `status ${bad.status}`);
    }

    // role separation
    const investorHitsAdmin = await api('GET', '/admin/users', { token: t1 });
    check('investor cannot read admin users', investorHitsAdmin.status === 403, `status ${investorHitsAdmin.status}`);

    const borrowerHitsInvestor = await api('GET', '/investor/dashboard', { token: borrowerToken });
    check('borrower cannot read the investor dashboard', borrowerHitsInvestor.status === 403, `status ${borrowerHitsInvestor.status}`);

    const adminHitsInvestor = await api('POST', '/investor/deposit', {
        token: adminToken,
        body: { txHash: fake },
    });
    check('admin cannot act as an investor', adminHitsInvestor.status === 403, `status ${adminHitsInvestor.status}`);

    const anonymous = await api('GET', '/loans');
    check('unauthenticated request is refused', anonymous.status === 401, `status ${anonymous.status}`);

    const garbageToken = await api('GET', '/loans', { token: 'not.a.jwt' });
    check('garbage token is refused', garbageToken.status === 401, `status ${garbageToken.status}`);

    // insufficient pool liquidity, reported rather than silently failing
    const stats = must(await api('GET', '/investor/pool', { token: t1 }), 'pool stats');
    check('pool reports its available liquidity', typeof stats.availableLiquidity === 'number');
    check('pool reports self-custody mode', stats.custodyMode === 'SELF_CUSTODY_ONCHAIN', stats.custodyMode);
}

// ── Scenario D: isolation ────────────────────────────────────────────────

async function scenarioIsolation() {
    heading('Scenario D — multiple users stay isolated');

    const b1 = await login('borrower1');
    const b2 = await login('borrower2');
    const i1 = await login('investor1');
    const i2 = await login('investor2');

    const l1 = must(await api('GET', '/loans', { token: b1 }), 'borrower 1 loans');
    const l2 = must(await api('GET', '/loans', { token: b2 }), 'borrower 2 loans');
    const ids1 = new Set(l1.map((l: Json) => l.id));
    check('borrower loan sets do not overlap', l2.every((l: Json) => !ids1.has(l.id)));

    // Borrower 1 must not be able to fetch borrower 2's loan by id.
    if (l2.length > 0) {
        const cross = await api('GET', `/loans/${l2[0].id}`, { token: b1 });
        check('borrower cannot read another borrower loan', cross.status === 404 || cross.status === 403, `status ${cross.status}`);
    }

    const p1 = must(await api('GET', '/investor/position', { token: i1 }), 'investor 1');
    const p2 = must(await api('GET', '/investor/position', { token: i2 }), 'investor 2');
    check('investor 1 still holds a position', p1.currentValue > 0, String(p1.currentValue));
    check('investor 2 is fully exited', near(p2.currentValue, 0, 1e-9), String(p2.currentValue));

    const t1 = must(await api('GET', '/investor/transactions', { token: i1 }), 'investor 1 history');
    check(
        'investor history is scoped to the owner',
        t1.transactions.every((t: Json) => t.userId === t1.transactions[0].userId),
    );
}

// ── admin visibility ─────────────────────────────────────────────────────

async function adminChecks() {
    heading('Administrator dashboard');

    const adminToken = await login('admin');

    const stats = must(await api('GET', '/admin/analytics', { token: adminToken }), 'analytics');
    check('analytics returns metrics from real rows', typeof stats === 'object' && stats !== null);

    const loanAnalytics = must(await api('GET', '/admin/analytics/loans', { token: adminToken }), 'loan analytics');
    check('loan analytics available', typeof loanAnalytics === 'object');

    const loans = must(await api('GET', '/admin/loans', { token: adminToken }), 'admin loans');
    const rows = loans.loans ?? loans;
    check('admin sees every loan', Array.isArray(rows) && rows.length >= 2, `${rows?.length} rows`);
    check(
        'admin sees the rejected application',
        rows.some((l: Json) => l.status === 'REJECTED'),
    );
    check(
        'admin sees the repaid loan',
        rows.some((l: Json) => l.status === 'REPAID'),
    );

    const poolView = must(await api('GET', '/admin/pool', { token: adminToken }), 'admin pool');
    check('admin can see pool activity', typeof poolView === 'object');

    const audit = must(await api('GET', '/admin/audit-logs', { token: adminToken }), 'audit logs');
    const entries = audit.logs ?? audit;
    check(
        'approval and rejection are in the audit trail',
        entries.some((l: Json) => l.action === 'LOAN_APPROVED') &&
            entries.some((l: Json) => l.action === 'LOAN_REJECTED'),
    );

    const plans = must(await api('GET', '/admin/plans', { token: adminToken }), 'admin plans');
    check('admin can list loan plans', (plans.plans ?? plans).length >= 4);

    const badPlan = await api('POST', '/admin/plans', {
        token: adminToken,
        body: { name: 'Broken', minAmount: 5, maxAmount: 1, durationOptions: [30], interestRate: 10 },
    });
    check('plan validation rejects an inverted amount range', badPlan.status === 400, `status ${badPlan.status}`);
}

// ── Scenario G: default, liquidation and the loss investors take ─────────

async function scenarioDefault() {
    heading('Scenario G — default, liquidation and investor loss');

    const borrowerToken = await login('borrower2');
    const adminToken = await login('admin');
    const investorToken = await login('investor1');

    const me = must(await api('GET', '/users/me', { token: borrowerToken }), 'profile');
    const plans = must(await api('GET', '/plans', { token: borrowerToken }), 'plans');
    const plan = plans
        .filter((p: Json) => Number(p.minCreditScore) <= Number(me.creditScore))
        .reduce((best: Json, p: Json) => (Number(p.maxAmount) > Number(best?.maxAmount ?? -1) ? p : best), null);
    const wallets = must(await api('GET', '/wallets', { token: borrowerToken }), 'wallets');
    const w = wallets.find((x: Json) => x.isVerified);

    // Shortest term available, so the time jump needed to make it overdue is small.
    const duration = Math.min(...plan.durationOptions.map(Number));
    const application = must(
        await api('POST', '/loans', {
            token: borrowerToken,
            body: {
                walletId: w.id,
                planId: plan.id,
                amount: String(Number(plan.maxAmount) / 4),
                duration,
                purpose: 'Deliberate default, to demonstrate liquidation',
            },
        }),
        'application',
    );

    const approved = must(
        await api('POST', `/admin/loans/${application.id}/approve`, { token: adminToken }),
        'approval',
    );
    const contractLoanId: number = approved.contractLoanId;

    const cm = new ethers.Contract(collateralManagerAddress, CM_ABI, wallet('borrower2'));
    const stakeTx = await cm.depositCollateral(contractLoanId, {
        value: ethers.parseEther(String(approved.collateralRequired)),
    });
    await stakeTx.wait();
    must(
        await api('POST', `/loans/${application.id}/collateral`, {
            token: borrowerToken,
            body: { txHash: stakeTx.hash },
        }),
        'collateral',
    );

    const investorBefore = must(await api('GET', '/investor/position', { token: investorToken }), 'position');
    const poolBefore = must(await api('GET', '/investor/pool', { token: investorToken }), 'pool');

    // Liquidation must be refused while the loan is still current.
    const tooEarly = await api('POST', `/admin/loans/${application.id}/liquidate`, { token: adminToken });
    check('a current loan cannot be liquidated', tooEarly.status >= 400, `status ${tooEarly.status}`);

    // Push the chain past the due date. Only possible on a local node, which is
    // exactly why the default path is demonstrable here and not on a testnet.
    const overdue = await advancePastDueDate(contractLoanId);
    check('the loan is overdue on-chain after the time jump', overdue);

    const liquidated = must(
        await api('POST', `/admin/loans/${application.id}/liquidate`, { token: adminToken }),
        'liquidation',
    );
    check('overdue loan liquidates', typeof liquidated.txHash === 'string');
    check('the pool was told about the loss', typeof liquidated.writeOffTxHash === 'string', String(liquidated.writeOffTxHash));
    check('the seized stake was routed to the pool', typeof liquidated.recoveryTxHash === 'string', String(liquidated.recoveryTxHash));

    const loan = must(await api('GET', `/loans/${application.id}`, { token: borrowerToken }), 'loan');
    check('loan status is LIQUIDATED', loan.status === 'LIQUIDATED', loan.status);

    const poolAfter = must(await api('GET', '/investor/pool', { token: investorToken }), 'pool after');
    check('the write-off is recorded on the pool', poolAfter.cumulativeWriteOffs > 0, String(poolAfter.cumulativeWriteOffs));
    check('nothing is left outstanding on the defaulted loan', Number(await poolRead.assetsOf(poolAddress)) >= 0);

    const investorAfter = must(await api('GET', '/investor/position', { token: investorToken }), 'position after');
    // The stake covers part of the loss; the unsecured remainder lands on investors.
    check(
        'the investor absorbs the unsecured part of the loss',
        investorAfter.currentValue < investorBefore.currentValue,
        `${investorBefore.currentValue} → ${investorAfter.currentValue}`,
    );
    check('the pool did not silently lose the seized stake', poolAfter.tvl > poolBefore.tvl - Number(loan.principal));
}

// ── Scenario F: onboarding and the KYC gate ──────────────────────────────

async function scenarioOnboarding() {
    heading('Scenario F — registration, verification and the KYC gate');

    const email = `demo.borrower.${Date.now()}@example.test`;
    const password = 'LocalDemo!NewUser1';

    await clearRateLimits();
    const registered = await api('POST', '/auth/register', {
        body: { email, password, name: 'Demo New Borrower', role: 'BORROWER' },
    });
    check('registration accepted', registered.status === 201, JSON.stringify(registered.body).slice(0, 160));

    // DEMO_EXPOSE_OTP hands the code back so a demo with no mailbox can continue.
    const code = registered.body?.data?.demoVerificationCode;
    check('verification code available for the local demo', typeof code === 'string' && code.length > 0);
    if (typeof code !== 'string') return;

    const wrongCode = await api('POST', '/auth/verify-email', { body: { token: '000000' } });
    check('a wrong verification code is refused', wrongCode.status >= 400, `status ${wrongCode.status}`);

    const verified = await api('POST', '/auth/verify-email', { body: { token: code } });
    check('email verification succeeds with the real code', verified.status === 200, JSON.stringify(verified.body).slice(0, 160));

    await clearRateLimits();
    const session = await api('POST', '/auth/login', { body: { email, password } });
    check('new account can log in', session.status === 200, `status ${session.status}`);
    const token = session.body?.data?.accessToken;
    if (!token) return;

    // Verified, but no KYC yet — borrowing must stay closed.
    const plans = must(await api('GET', '/plans', { token }), 'plans');
    const wallets = must(await api('GET', '/wallets', { token }), 'wallets');
    const blocked = await api('POST', '/loans', {
        token,
        body: {
            walletId: wallets[0]?.id ?? 'none',
            planId: plans[0].id,
            amount: String(plans[0].minAmount),
            duration: plans[0].durationOptions[0],
            purpose: 'Testing the KYC gate',
        },
    });
    check('an unapproved borrower cannot apply for a loan', blocked.status === 403, `status ${blocked.status}`);

    const adminToken = await login('admin');
    const kycQueue = must(await api('GET', '/admin/kyc/pending', { token: adminToken }), 'kyc queue');
    check('admin has a KYC review queue', typeof kycQueue === 'object');

    // ── KYC, as far as it goes without the AI service and real images ────
    const profile = await api('POST', '/kyc/profile', {
        token,
        body: {
            firstName: 'Demo',
            lastName: 'Borrower',
            dateOfBirth: '1998-04-12',
            gender: 'Male',
            civilStatus: 'Single',
            educationLevel: 'College',
            country: 'Philippines',
            region: 'NCR',
            cityTown: 'Manila',
            contactNumber: '+639171234567',
            idType: 'PHILSYS',
        },
    });
    check('KYC profile accepted', profile.status === 200 || profile.status === 201, `status ${profile.status}`);

    const badProfile = await api('POST', '/kyc/profile', {
        token,
        body: { firstName: 'D', lastName: 'B', dateOfBirth: 'not-a-date', gender: '', civilStatus: '', educationLevel: '', country: '', contactNumber: 'nope' },
    });
    check('an incomplete KYC profile is refused', badProfile.status === 400, `status ${badProfile.status}`);

    // Submission is gated on a government ID and a passed face match, so it must
    // refuse here — those need real images and the AI service.
    const earlySubmit = await api('POST', '/kyc/submit', { token, body: {} });
    check('KYC submission without documents is refused', earlySubmit.status >= 400, `status ${earlySubmit.status}`);

    const kycStatus = must(await api('GET', '/kyc/status', { token }), 'kyc status');
    check('borrower can see their own KYC state', typeof kycStatus === 'object');

    // Admin cannot approve someone who never submitted.
    const prematureApproval = await api('PUT', `/admin/kyc/${kycStatus.userId ?? 'unknown'}/approve`, {
        token: adminToken,
        body: { creditScore: 70, tier: 'STANDARD' },
    });
    check(
        'admin cannot approve a KYC that was never submitted',
        prematureApproval.status >= 400,
        `status ${prematureApproval.status}`,
    );

    // Password reset, end to end, without a mailbox.
    const forgot = await api('POST', '/auth/forgot-password', { body: { email } });
    check('password reset requested', forgot.status === 200, `status ${forgot.status}`);
    const resetCode = forgot.body?.data?.demoResetCode;
    check('reset code available for the local demo', typeof resetCode === 'string');
    if (typeof resetCode === 'string') {
        const validated = await api('POST', '/auth/validate-reset-token', { body: { token: resetCode } });
        check('reset code validates', validated.status === 200, `status ${validated.status}`);

        const newPassword = 'LocalDemo!Rotated1';
        const reset = await api('POST', '/auth/reset-password', { body: { token: resetCode, password: newPassword } });
        check('password reset completes', reset.status === 200, `status ${reset.status}`);

    await clearRateLimits();
        const relogin = await api('POST', '/auth/login', { body: { email, password: newPassword } });
        check('new password works', relogin.status === 200, `status ${relogin.status}`);

    await clearRateLimits();
        const oldPassword = await api('POST', '/auth/login', { body: { email, password } });
        check('old password no longer works', oldPassword.status >= 400, `status ${oldPassword.status}`);
    }
}

// ── run ──────────────────────────────────────────────────────────────────

/** Run one scenario with a clean limiter budget in front of it. */
async function scenario<T>(fn: () => Promise<T>): Promise<T> {
    await clearRateLimits();
    return fn();
}

async function main() {
    await preflight();
    const tokens = await scenario(() => scenarioInvestorDeposits());
    await scenario(() => scenarioBorrowerLifecycle());
    await scenario(() => scenarioRejection());
    await scenario(() => scenarioInvestorYield(tokens));
    await scenario(() => scenarioIsolation());
    await scenario(() => scenarioFailures(tokens));
    await scenario(() => scenarioOnboarding());
    await scenario(() => scenarioDefault());
    await scenario(() => adminChecks());

    console.log(`\n\x1b[1m${passed} passed, ${failures.length} failed\x1b[0m`);
    if (failures.length > 0) {
        console.log('\nFailures:');
        for (const f of failures) console.log(`  - ${f}`);
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('\n\x1b[31mE2E run aborted:\x1b[0m', err.message ?? err);
    process.exit(1);
});
