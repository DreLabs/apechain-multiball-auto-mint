// --- Branding Banner ---
console.log(`
 ..................................................... 
.-----------------------------------------------------.
.-----------------------------------------------------.
.-----------------------------------------------------.
.-----------------------------------------------------.
.---------------------------:..........:--------------.
.--------------------------..@%@%@##%@:.:-------------.
.-----------------------:...#@=@#@*@###:.:------------.
.---------------------:..#@*@#%+-@@@.@@@*:------------.
.--------------........*%.  %:  .  .. . =..:----------.
.-------------.:@@@@#@-.  #@::@@@@@..@@@@+*.----------.
.-------------.@-. *@%@@@:@ :# :==#---++:@%.----------.
.------------::***: -   . @* @@=-..@@@+#=*%.----------.
.-------------.%*@#%@@@@@@=.= .%@-@  =..*+=:----------.
.-------------:..@@%@@.%. *#@.-: .@.@@.#=%.:----------.
.---------------......#**%@%=@-:@=#- %..%.::----------.
.--------------------..@%.%*@%.+ @:..+..@:@.----------.
.---------------------...@#+..*# #:=:--:+=*::---------.
.--------------------:.@#*#@-:@*%%+**.@*%@-=:---------.
.-------------------:..:#@@@@ :  =.. @@#@@#.----------.
.------------------:..@@#-=:%.@##@:-@::+.+-:----------.
.-----------------:..%+@%##*- #%.+-=@:-@@.::----------.
.---------------:....% *-+@@@@#..#:*.-@.::------------.
.------------.....@@@@@@#*%*%%@@........:-------------.
.--------:..  @@@@@#@@@@@@@@@@@@@@@@...---------------.
.-------..:@@@@##%@@@@@@@@@@@@@@@@@@@@..--------------.
.------..@@@@@@@@@@    . :+ :  :@#%%@@=.--------------.
.-----:.@@@%%@%%*#@ @= %@ .=@-@%@%@@@@@..-------------.
.-----..@@#%%@@%@@@ @#@**=@ @ @ @%%#@@@-.-------------.
 ..... @@****+*%**@+:-#+*#*##+**%+#+@*#@.............. 


               made by
        DRECENTRALIZED.eth
`);

import { ethers } from "ethers";
import "dotenv/config";
import readline from "readline";

const RPC = "https://rpc.apechain.com";
const CONTRACT = "0x075893707e168162234b62a5b39650e124ff3321".toLowerCase();
const ABI = [
  "function mint() payable",
  "function mintedToday(address) view returns (uint256)",
  "function dailyLimit() view returns (uint256)",
  "function lastMinted(address) view returns (uint256)"
];

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

function formatTimes(epochSeconds) {
  if (!epochSeconds || epochSeconds <= 0) return { local: "N/A", utc: "N/A" };
  const ms = Number(epochSeconds) * 1000;
  const local = new Date(ms).toLocaleString();
  const utc = new Date(ms).toISOString().replace("T", " ").replace("Z", " UTC");
  return { local, utc };
}

// NEW: countdown formatter
function formatCountdown(secondsBigInt) {
  const total = Math.max(0, Number(secondsBigInt ?? 0n));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return `${hrs} Hours ${mins} Min ${secs} Sec`;
}

async function main() {
  const qtyStr = await ask("How many Multiballs do you want to mint? ");
  rl.close();

  let qty = parseInt(qtyStr, 10);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error("Invalid quantity. Please enter a positive whole number.");
  }

  // Free mint
  const mintPrice = 0n;

  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT, ABI, wallet);

  const [limit, already, last] = await Promise.all([
    contract.dailyLimit(),
    contract.mintedToday(wallet.address),
    contract.lastMinted(wallet.address)
  ]);

  const nextResetSeconds = (last && last > 0n) ? (last + 86400n) : 0n;
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const untilReset = nextResetSeconds > nowSeconds ? (nextResetSeconds - nowSeconds) : 0n;
  const { local: nextLocal, utc: nextUTC } = formatTimes(nextResetSeconds);

  console.log(`\nWallet: ${wallet.address}`);
  console.log(`Daily limit: ${limit.toString()}`);
  console.log(`Already minted today: ${already.toString()}`);
  console.log(`Mint price: FREE (0 APE) — only gas costs apply`);
  if (nextResetSeconds > 0n) {
    console.log(`Next daily reset at: ${nextLocal} (local) | ${nextUTC}`);
  }

  if (limit > 0n && already >= limit) {
    console.error("\n❌ You have already minted the maximum allowed for today.");
    if (untilReset > 0n) {
      console.error(`   You can mint again in: ${formatCountdown(untilReset)}`);
    }
    return;
  }

  let remainingToday = (limit === 0n) ? BigInt(qty) : (limit - already);
  if (BigInt(qty) > remainingToday) {
    console.log(`\n⚠️ You asked for ${qty}, but can only mint ${remainingToday} today.`);
    console.log(`   Minting ${remainingToday} instead...`);
    qty = Number(remainingToday);
  }

  console.log(`\nStarting mint: ${qty} Multiballs @ FREE (0 APE)\n`);

  let mintedCount = 0;
  for (let i = 0; i < qty; i++) {
    console.log(`Minting #${i + 1} of ${qty}...`);
    try {
      const tx = await contract.mint({ value: mintPrice });
      console.log("Tx hash:", tx.hash);
      const rc = await tx.wait();
      console.log("✅ Confirmed in block", rc.blockNumber);
      mintedCount++;
      await new Promise((r) => setTimeout(r, 1000));
    } catch (err) {
      if (err?.reason?.includes("Exceeds daily mint limit")) {
        console.error("❌ You have already minted the maximum allowed for today.");
      } else {
        console.error("❌ Error:", err?.message ?? String(err));
      }
      break;
    }
  }

  const [updatedLast, updatedMintedToday] = await Promise.all([
    contract.lastMinted(wallet.address),
    contract.mintedToday(wallet.address)
  ]);
  const updatedNextReset = (updatedLast && updatedLast > 0n) ? (updatedLast + 86400n) : 0n;

  console.log(`\nSummary: minted ${mintedCount}/${qty} this run.`);
  console.log(`Minted today (now): ${updatedMintedToday.toString()} / ${limit.toString()}`);

  if (updatedNextReset > 0n) {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const remaining = updatedNextReset > now ? (updatedNextReset - now) : 0n;
    console.log(`You can mint again in: ${formatCountdown(remaining)}`);
  }

  if (mintedCount > 0) {
    console.log(`\n🎉 Success! Your Multiballs are minted — now spin the *Wheel of Fate*! 🌀 May fortune favor you!`);
    console.log(`\n💰 Send tips to: drecentralized.eth & BUY $HOES`);
  }
}

main().catch((e) => {
  console.error("Fatal error:", e?.message ?? String(e));
  process.exit(1);
});
