const http = require('http');
const fs = require('fs');
const path = require('path');
const { Connection, PublicKey, Keypair, Transaction, SystemProgram } = require('@solana/web3.js');
const bs58 = require('bs58').default || require('bs58');

// Config
const PORT = 3001;
const RPC_URL = 'https://rpc.trashscan.io';
const HOUSE_PRIVATE_KEY = '2thseXAxnhbvsRtU7Jsv392QB71UvLaXcVd2nWrruHX4kKGhFYVDAnaj1TfzbcpCiEdvfxckntbjo4NJhQ45sLFD';
const DB_PATH = path.join(__dirname, 'db.json');
const GOR_DECIMALS = 9;
const LAMPORTS_PER_GOR = 10 ** GOR_DECIMALS;
const MIN_DEPOSIT = 10 * LAMPORTS_PER_GOR;
const MAX_BET = 1000 * LAMPORTS_PER_GOR;
const MULTIPLIER = 2;

// Load house wallet
const houseKeypair = Keypair.fromSecretKey(bs58.decode(HOUSE_PRIVATE_KEY));
const HOUSE_PUBKEY = houseKeypair.publicKey.toString();
console.log('House wallet:', HOUSE_PUBKEY);

// Connection
const connection = new Connection(RPC_URL, 'confirmed');

// Simple JSON DB
function loadDB() {
    try {
        return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    } catch {
        return { users: {}, processedTxs: [], stats: { totalBets: 0, totalWagered: 0, housePnl: 0 } };
    }
}

function saveDB(db) {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// Get user balance
function getBalance(db, wallet) {
    return db.users[wallet]?.balance || 0;
}

// Check for new deposits
async function checkDeposits(wallet) {
    const db = loadDB();
    const housePubkey = new PublicKey(HOUSE_PUBKEY);
    
    try {
        // Get recent signatures for house wallet
        const sigs = await connection.getSignaturesForAddress(housePubkey, { limit: 50 });
        
        for (const sig of sigs) {
            if (db.processedTxs.includes(sig.signature)) continue;
            
            try {
                const tx = await connection.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
                if (!tx || !tx.meta || tx.meta.err) continue;
                
                // Check if this is a transfer TO house wallet
                const preBalances = tx.meta.preBalances;
                const postBalances = tx.meta.postBalances;
                const accounts = tx.transaction.message.accountKeys;
                
                const houseIdx = accounts.findIndex(a => a.pubkey.toString() === HOUSE_PUBKEY);
                
                if (houseIdx >= 0) {
                    const houseReceived = postBalances[houseIdx] - preBalances[houseIdx];
                    if (houseReceived > 0) {
                        // Find sender
                        let senderAddr = null;
                        for (let i = 0; i < accounts.length; i++) {
                            if (i !== houseIdx && preBalances[i] - postBalances[i] >= houseReceived) {
                                senderAddr = accounts[i].pubkey.toString();
                                break;
                            }
                        }
                        
                        if (senderAddr) {
                            // Credit user
                            if (!db.users[senderAddr]) {
                                db.users[senderAddr] = { balance: 0, wins: 0, losses: 0, wagered: 0 };
                            }
                            db.users[senderAddr].balance += houseReceived;
                            db.processedTxs.push(sig.signature);
                            console.log(`Deposit: ${senderAddr} +${houseReceived / LAMPORTS_PER_GOR} GOR`);
                        }
                    }
                }
            } catch (e) {
                console.error('Error processing tx:', e.message);
            }
        }
        
        // Keep only last 1000 processed txs
        if (db.processedTxs.length > 1000) {
            db.processedTxs = db.processedTxs.slice(-1000);
        }
        
        saveDB(db);
        return getBalance(db, wallet);
    } catch (e) {
        console.error('Error checking deposits:', e.message);
        return getBalance(db, wallet);
    }
}

// Play a round
async function playRound(wallet, betAmount, chosenBag) {
    const db = loadDB();
    
    // Validate
    if (!db.users[wallet]) {
        return { error: 'No balance. Deposit GOR first.' };
    }
    
    const balance = db.users[wallet].balance;
    if (betAmount > balance) {
        return { error: 'Insufficient balance' };
    }
    if (betAmount < MIN_DEPOSIT) {
        return { error: 'Min bet is 10 GOR' };
    }
    if (betAmount > MAX_BET) {
        return { error: 'Max bet is 1000 GOR' };
    }
    
    // Deduct bet
    db.users[wallet].balance -= betAmount;
    db.users[wallet].wagered = (db.users[wallet].wagered || 0) + betAmount;
    db.stats.totalBets++;
    db.stats.totalWagered += betAmount;
    
    // Determine winner (random)
    const winningBag = Math.floor(Math.random() * 3);
    const won = chosenBag === winningBag;
    
    let payout = 0;
    if (won) {
        payout = betAmount * MULTIPLIER;
        db.users[wallet].balance += payout;
        db.users[wallet].wins = (db.users[wallet].wins || 0) + 1;
        db.stats.housePnl -= (payout - betAmount);
    } else {
        db.users[wallet].losses = (db.users[wallet].losses || 0) + 1;
        db.stats.housePnl += betAmount;
    }
    
    saveDB(db);
    
    return {
        won,
        winningBag,
        payout: won ? payout : 0,
        newBalance: db.users[wallet].balance,
        stats: db.users[wallet]
    };
}

// Withdraw
async function withdraw(wallet, amount) {
    const db = loadDB();
    
    if (!db.users[wallet] || db.users[wallet].balance < amount) {
        return { error: 'Insufficient balance' };
    }
    
    if (amount < MIN_DEPOSIT) {
        return { error: 'Min withdrawal is 10 GOR' };
    }
    
    try {
        // Check house has enough
        const houseBalance = await connection.getBalance(new PublicKey(HOUSE_PUBKEY));
        if (houseBalance < amount + 5000) {
            return { error: 'House temporarily low on funds. Try again later.' };
        }
        
        // Send GOR
        const tx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: houseKeypair.publicKey,
                toPubkey: new PublicKey(wallet),
                lamports: amount
            })
        );
        
        const latestBlockhash = await connection.getLatestBlockhash();
        tx.recentBlockhash = latestBlockhash.blockhash;
        tx.feePayer = houseKeypair.publicKey;
        
        const sig = await connection.sendTransaction(tx, [houseKeypair]);
        await connection.confirmTransaction(sig, 'confirmed');
        
        // Deduct from balance
        db.users[wallet].balance -= amount;
        saveDB(db);
        
        console.log(`Withdrawal: ${wallet} -${amount / LAMPORTS_PER_GOR} GOR (${sig})`);
        
        return { 
            success: true, 
            signature: sig,
            newBalance: db.users[wallet].balance
        };
    } catch (e) {
        console.error('Withdrawal error:', e);
        return { error: 'Withdrawal failed: ' + e.message };
    }
}

// Get leaderboard
function getLeaderboard() {
    const db = loadDB();
    const players = Object.entries(db.users)
        .map(([wallet, data]) => ({
            wallet: wallet.slice(0, 4) + '...' + wallet.slice(-4),
            wagered: data.wagered || 0,
            wins: data.wins || 0,
            losses: data.losses || 0
        }))
        .filter(p => p.wins + p.losses > 0)
        .sort((a, b) => b.wagered - a.wagered)
        .slice(0, 10);
    
    return { 
        leaderboard: players,
        houseStats: db.stats
    };
}

// HTTP Server
const server = http.createServer(async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    // Serve static files
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        res.setHeader('Content-Type', 'text/html');
        res.writeHead(200);
        res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
        return;
    }
    
    // API endpoints
    const url = new URL(req.url, `http://localhost:${PORT}`);
    
    if (req.method === 'GET' && url.pathname === '/api/balance') {
        const wallet = url.searchParams.get('wallet');
        if (!wallet) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'wallet required' }));
            return;
        }
        const balance = await checkDeposits(wallet);
        const db = loadDB();
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ 
            balance, 
            balanceGor: balance / LAMPORTS_PER_GOR,
            stats: db.users[wallet] || {}
        }));
        return;
    }
    
    if (req.method === 'POST' && url.pathname === '/api/play') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { wallet, betAmount, chosenBag } = JSON.parse(body);
                const result = await playRound(wallet, betAmount, chosenBag);
                res.setHeader('Content-Type', 'application/json');
                res.writeHead(result.error ? 400 : 200);
                res.end(JSON.stringify(result));
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }
    
    if (req.method === 'POST' && url.pathname === '/api/withdraw') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { wallet, amount } = JSON.parse(body);
                const result = await withdraw(wallet, amount);
                res.setHeader('Content-Type', 'application/json');
                res.writeHead(result.error ? 400 : 200);
                res.end(JSON.stringify(result));
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }
    
    if (req.method === 'GET' && url.pathname === '/api/leaderboard') {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify(getLeaderboard()));
        return;
    }
    
    if (req.method === 'GET' && url.pathname === '/api/house') {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ wallet: HOUSE_PUBKEY }));
        return;
    }
    
    res.writeHead(404);
    res.end('Not found');
});

server.listen(PORT, () => {
    console.log(`🗑️ Dumpster Dive server running on http://localhost:${PORT}`);
    console.log(`House wallet: ${HOUSE_PUBKEY}`);
});
