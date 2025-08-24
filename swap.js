// swap.js – ethers v6 safe, probes per-swap count, filters by ballType
import { ethers } from "ethers";
import fs from "fs";
import readline from "readline";
import "dotenv/config";

/* ====== Shared config (same knobs as mint2.js) ====== */
const RPC               = process.env.RPC || "https://rpc.apechain.com";
const EXPECTED_CHAIN_ID = BigInt(process.env.EXPECTED_CHAIN_ID || "33139");
const PRIVATE_KEY       = process.env.PRIVATE_KEY;

const NFT_CONTRACT  = (process.env.NFT_CONTRACT  || "0x075893707e168162234B62A5B39650e124FF3321").toLowerCase(); // Multiball
const SWAP_CONTRACT = (process.env.SWAP_CONTRACT || "0x80a5e6d411002891E519F531785e7686B3c467Ed").toLowerCase();

const BALL_TYPE      = Number(process.env.BALL_TYPE || "0"); // e.g. 2
const CONCURRENCY    = Number(process.env.CONCURRENCY || "10");
const CONFIRMATIONS  = Number(process.env.CONFIRMATIONS || "0"); // 0=send-only
const TX_TIMEOUT_MS  = Number(process.env.TX_TIMEOUT_MS || "120000");
const SEND_DELAY_MS  = Number(process.env.SEND_DELAY_MS || "50");

// Optional override if you already know the exact required number
const REQUIRED_PER_SWAP_OVERRIDE = process.env.REQUIRED_PER_SWAP
  ? Number(process.env.REQUIRED_PER_SWAP)
  : null;

// Fallback for event-scan discovery (if enumerable not available)
const SCAN_BLOCKS_BACK = Number(process.env.SCAN_BLOCKS_BACK || "250000");

const bump  = (v) => (v == null ? null : v + v / 5n);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ============================== ABIs ============================== */
const SWAP_ABI = [
  "function swapForPrize(uint8 ballType, uint256[] ballTokenIds, uint256 traceId)"
];

const ERC721_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "function balanceOf(address) view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
  // enumerable (optional)
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)"
];

/* ============================ helpers ============================= */
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, (a) => resolve((a ?? "").trim())));

function nextTraceId(i) {
  const base = BigInt(Date.now()) * 1_000_000n;
  return base + BigInt(i);
}
function addressTopic(addr) {
  return ethers.zeroPadValue(ethers.getAddress(addr), 32); // v6-safe topic padding
}

async function ensureApproval(nft, owner, operator, confirmations = 1) {
  const ok = await nft.isApprovedForAll(owner, operator);
  if (ok) return;
  console.log(`\nGranting operator approval to ${operator}…`);
  const tx = await nft.setApprovalForAll(operator, true);
  console.log(`   approval tx: ${tx.hash}`);
  await tx.wait(confirmations);
  console.log("   ✅ operator approved\n");
}

async function getOwnedEnumerable(nft, owner) {
  try { await nft.tokenOfOwnerByIndex.staticCall(owner, 0); } catch { return null; }
  const bal = await nft.balanceOf(owner);
  const n = Number(bal);
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(await nft.tokenOfOwnerByIndex(owner, i));
  return ids;
}

async function getOwnedByEvents(nft, owner, provider) {
  console.log("Enumerable not available — falling back to Transfer log scan.");
  const topicTransfer = ethers.id("Transfer(address,address,uint256)");
  const latest    = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latest - SCAN_BLOCKS_BACK);
  console.log(`Scanning logs ${fromBlock} → ${latest} (≈${SCAN_BLOCKS_BACK} blocks)…`);

  const logsTo = await provider.getLogs({
    address: NFT_CONTRACT, fromBlock, toBlock: latest,
    topics: [topicTransfer, null, addressTopic(owner)],
  });
  const logsFrom = await provider.getLogs({
    address: NFT_CONTRACT, fromBlock, toBlock: latest,
    topics: [topicTransfer, addressTopic(owner), null],
  });

  const have = new Set();
  for (const l of logsTo)   have.add(ethers.toBigInt(l.topics[3]).toString());
  for (const l of logsFrom) have.delete(ethers.toBigInt(l.topics[3]).toString());

  const candidates = Array.from(have).map(s => ethers.toBigInt(s));
  const verified = [];
  const ownerLc = owner.toLowerCase();
  const chunk = 25;
  for (let i = 0; i < candidates.length; i += chunk) {
    const slice = candidates.slice(i, i + chunk);
    const results = await Promise.all(slice.map(async (id) => {
      try { return (await nft.ownerOf(id)).toLowerCase(); } catch { return null; }
    }));
    for (let j = 0; j < slice.length; j++) {
      if (results[j] === ownerLc) verified.push(slice[j]);
    }
  }
  return verified;
}

async function loadOwnedTokenIds(nft, owner, provider) {
  if (process.env.TOKEN_IDS) {
    return process.env.TOKEN_IDS.split(",").map(s => s.trim()).filter(Boolean).map(ethers.toBigInt);
  }
  if (fs.existsSync("token_ids.txt")) {
    const lines = fs.readFileSync("token_ids.txt", "utf8").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (lines.length) return lines.map(ethers.toBigInt);
  }
  const enumerableIds = await getOwnedEnumerable(nft, owner);
  if (enumerableIds?.length) return enumerableIds;
  return await getOwnedByEvents(nft, owner, provider);
}

/** v6-safe: try several common ball-type getters and return a callable or null. */
async function detectBallTypeGetter(nft, sampleTokenId) {
  const candidates = [
    { sig: "function ballType(uint256) view returns (uint8)",     key: "ballType(uint256)" },
    { sig: "function tokenBallType(uint256) view returns (uint8)", key: "tokenBallType(uint256)" },
    { sig: "function ballTypes(uint256) view returns (uint8)",     key: "ballTypes(uint256)" },
    { sig: "function getBallType(uint256) view returns (uint8)",   key: "getBallType(uint256)" },
  ];
  for (const { sig, key } of candidates) {
    try {
      const iface = new ethers.Interface([sig]);
      const data  = iface.encodeFunctionData(key, [sampleTokenId]);
      const ret   = await nft.provider.call({ to: nft.target, data });
      const out   = iface.decodeFunctionResult(key, ret)[0];
      const val   = Number(out);
      if (Number.isFinite(val)) {
        return async (tokenId) => {
          const d  = iface.encodeFunctionData(key, [tokenId]);
          const rr = await nft.provider.call({ to: nft.target, data: d });
          return Number(iface.decodeFunctionResult(key, rr)[0]);
        };
      }
    } catch {/* try next */}
  }
  return null;
}

/** Probe how many balls are needed per swap via staticCall. */
async function discoverRequiredPerSwap(swap, candidateIds, maxProbe = 40) {
  const pool = candidateIds.slice(0, Math.min(candidateIds.length, maxProbe));
  if (pool.length === 0) throw new Error("No candidate tokenIds available to probe required count.");
  for (let k = 1; k <= pool.length; k++) {
    const ids = pool.slice(0, k);
    try { await swap.swapForPrize.staticCall(BALL_TYPE, ids, 0n); return k; }
    catch {/* keep trying */}
  }
  throw new Error(`Could not determine required number of balls (tried up to ${pool.length}). Set REQUIRED_PER_SWAP in .env`);
}

/* ============================== main ============================== */
async function main() {
  if (!PRIVATE_KEY || !/^0x[0-9a-fA-F]{64}$/.test(PRIVATE_KEY)) {
    throw new Error("Set PRIVATE_KEY in .env (0x + 64 hex chars).");
  }

  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);

  const net = await provider.getNetwork();
  console.log("Connected chainId:", net.chainId.toString());
  if (net.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`Refusing to run: connected chainId ${net.chainId} != expected ${EXPECTED_CHAIN_ID}`);
  }

  const nft  = new ethers.Contract(NFT_CONTRACT, ERC721_ABI, wallet);
  const swap = new ethers.Contract(SWAP_CONTRACT, SWAP_ABI, wallet);

  // Discover owned token IDs
  let owned = await loadOwnedTokenIds(nft, wallet.address, provider);
  owned = owned.map(ethers.toBigInt).sort((a,b)=> (a<b?-1:1));

  console.log(`\nOwner: ${wallet.address}`);
  console.log(`NFT contract:  ${NFT_CONTRACT}`);
  console.log(`Swap contract: ${SWAP_CONTRACT}`);
  console.log(`Found owned balls: ${owned.length}`);
  if (owned.length === 0) { console.log("No balls owned. Exiting."); rl.close(); return; }

  // Approval first (some contracts branch logic based on approval path)
  await ensureApproval(nft, wallet.address, SWAP_CONTRACT, Math.max(CONFIRMATIONS,1));

  // Determine required balls per swap
  let perSwap;
  if (REQUIRED_PER_SWAP_OVERRIDE && REQUIRED_PER_SWAP_OVERRIDE > 0) {
    perSwap = REQUIRED_PER_SWAP_OVERRIDE;
    console.log(`Using REQUIRED_PER_SWAP from env: ${perSwap}`);
  } else {
    console.log("Probing required balls per swap…");
    perSwap = await discoverRequiredPerSwap(swap, owned, 50);
    console.log(`Detected required balls per swap: ${perSwap}`);
  }

  // Detect ballType getter and filter tokens to the requested BALL_TYPE
  let filtered = owned;
  const typeGetter = await detectBallTypeGetter(nft, owned[0]);
  if (typeGetter) {
    console.log(`Detected ballType view; filtering to type ${BALL_TYPE}…`);
    const chunk = 50;
    const keep = [];
    for (let i = 0; i < owned.length; i += chunk) {
      const slice = owned.slice(i, i + chunk);
      const types = await Promise.all(slice.map(id => typeGetter(id).catch(()=>null)));
      for (let j = 0; j < slice.length; j++) if (types[j] === BALL_TYPE) keep.push(slice[j]);
    }
    filtered = keep;
    console.log(`Tokens of ballType ${BALL_TYPE}: ${filtered.length}`);
  } else {
    console.log("⚠️  Could not read ballType on-chain. Using ALL owned IDs; if mixed types, swaps may revert.");
    console.log("    Tip: set TOKEN_IDS in .env with only matching IDs to avoid reverts.");
  }

  const maxSwaps = Math.floor(filtered.length / perSwap);
  if (maxSwaps <= 0) {
    console.log(`You need ${perSwap} balls of type ${BALL_TYPE} per swap. You currently have ${filtered.length}. Exiting.`);
    rl.close();
    return;
  }

  console.log(`You can do a maximum of ${maxSwaps} swap(s) (${perSwap} balls of type ${BALL_TYPE} per swap).`);
  const ans = await ask(`How many swaps do you want to perform? [default: ${maxSwaps}] `);
  rl.close();

  let swapsToDo = ans ? parseInt(ans, 10) : maxSwaps;
  if (!Number.isFinite(swapsToDo) || swapsToDo <= 0) { console.log("Invalid input. Exiting."); return; }
  if (swapsToDo > maxSwaps) { console.log(`Clamping to max: ${maxSwaps}`); swapsToDo = maxSwaps; }

  // Build jobs
  const useCount = swapsToDo * perSwap;
  const tokenIdsToUse = filtered.slice(0, useCount);
  const jobs = [];
  for (let i = 0; i < swapsToDo; i++) {
    const start = i * perSwap;
    const ids   = tokenIdsToUse.slice(start, start + perSwap);
    jobs.push({ idx: i + 1, tokenIds: ids, traceId: nextTraceId(i) });
  }

  // Gas overrides
  const feeData = await provider.getFeeData();
  const baseOverrides = {};
  if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
    baseOverrides.maxFeePerGas = bump(feeData.maxFeePerGas);
    baseOverrides.maxPriorityFeePerGas = bump(feeData.maxPriorityFeePerGas);
  } else if (feeData.gasPrice) {
    baseOverrides.gasPrice = bump(feeData.gasPrice);
  }

  console.log(`\nStarting swapForPrize: ${swapsToDo} call(s)  |  ${perSwap} IDs per call  |  type=${BALL_TYPE}  |  window=${CONCURRENCY}\n`);

  // Nonce pipeline
  let nextNonce = await provider.getTransactionCount(wallet.address, "pending");
  let sent = 0;
  let confirmed = 0;
  const inflight = new Set();

  function waiter(hash, idx, nonceForLog) {
    if (CONFIRMATIONS <= 0) return Promise.resolve(null);
    const p = provider.waitForTransaction(hash, CONFIRMATIONS, TX_TIMEOUT_MS)
      .then((rc) => {
        if (rc) { console.log(`   ✅ [${idx}] confirmed (nonce=${nonceForLog}) block ${rc.blockNumber}`); confirmed++; }
        else   { console.log(`   ⚠️  [${idx}] no receipt within timeout (${TX_TIMEOUT_MS}ms)`); }
        return rc;
      })
      .catch((err) => { console.log(`   ❌ [${idx}] wait error: ${err?.reason || err?.message || err}`); return null; })
      .finally(() => inflight.delete(p));
    inflight.add(p);
    return p;
  }

  async function sendOne(job) {
    let tries = 0;
    while (true) {
      tries++;
      try {
        const overrides = { ...baseOverrides, nonce: nextNonce };
        const tx = await swap.swapForPrize(BALL_TYPE, job.tokenIds, job.traceId, overrides);
        console.log(`[send ${job.idx}/${jobs.length}] nonce=${nextNonce} ids=${job.tokenIds.map(String).join(",")} hash=${tx.hash}`);
        waiter(tx.hash, job.idx, nextNonce);
        nextNonce++; sent++; return;
      } catch (err) {
        const msg = (err?.reason || err?.shortMessage || err?.message || "").toLowerCase();
        if (msg.includes("nonce too low") || msg.includes("already known")) { nextNonce++; continue; }
        if (msg.includes("nonce too high")) {
          const synced = await provider.getTransactionCount(wallet.address, "pending");
          nextNonce = synced; continue;
        }
        if (msg.includes("too many requests") || msg.includes("rate limit")) {
          const backoff = 400 * Math.min(tries, 10); await sleep(backoff); continue;
        }
        console.log(`   ❌ [${job.idx}] send error: ${err?.reason || err?.message || err}`);
        if (tries < 5) { await sleep(700 * tries); continue; }
        return;
      }
    }
  }

  // Windowed loop
  let q = 0;
  while (q < jobs.length) {
    while (q < jobs.length && inflight.size < CONCURRENCY) {
      const job = jobs[q++]; await sendOne(job);
      if (SEND_DELAY_MS > 0) await sleep(SEND_DELAY_MS);
    }
    if (inflight.size) await Promise.race(inflight);
  }
  if (inflight.size) await Promise.allSettled(Array.from(inflight));

  console.log(`\nDone. Sent ${sent}/${jobs.length}${CONFIRMATIONS>0 ? ` | confirmed ${confirmed}` : ""}.`);
}

main().catch((e) => {
  console.error("Fatal error:", e?.message ?? String(e));
  process.exit(1);
});
