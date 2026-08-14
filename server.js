import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import { TurboFactory, EthereumSigner } from '@ardrive/turbo-sdk';
import crypto from 'crypto';
import session from 'express-session';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// KONFIGURĀCIJA NO RENDER MAINĪGAJIEM
// ==========================================
const RPC_URL = process.env.RPC_URL;
const OPERATOR_PRIVATE_KEY = process.env.OPERATOR_PRIVATE_KEY;
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS;
const NFT_ADDRESS = process.env.NFT_ADDRESS;
const SUBSCRIPTION_ADDRESS = process.env.SUBSCRIPTION_ADDRESS;
const TURBO_UPLOAD_URL = process.env.TURBO_UPLOAD_URL || 'https://upload.services.ar-io.dev';
const TURBO_PAYMENT_URL = process.env.TURBO_PAYMENT_URL || 'https://payment.services.ar-io.dev';
const API_KEY = process.env.API_KEY || '';
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const GITHUB_REDIRECT_URI = process.env.GITHUB_REDIRECT_URI;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const TREASURY_ABI = [
    "function payTurbo(uint256 amount, bytes32 paymentId) external",
    "function balance() external view returns (uint256)"
];

const NFT_ABI = [
    "function repositoryTokens(bytes32 repoHash) external view returns (uint256)",
    "function ownerOf(uint256 tokenId) external view returns (address)"
];

const SUBSCRIPTION_ABI = [
    "function isSubscribed(uint256 tokenId) external view returns (bool)"
];

// Pagaidu backupu glabātuve
const pendingBackups = new Map();

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false, maxAge: 3600000 }
}));

function checkApiKey(req, res, next) {
    if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
        return res.status(401).json({ error: 'Nederīga API atslēga' });
    }
    next();
}

// ==========================================
// IEGŪT KONFIGURĀCIJU (priekš frontend)
// ==========================================
app.get('/api/config', (req, res) => {
    res.json({
        chainId: '0x14a34',
        treasuryAddress: TREASURY_ADDRESS,
        nftAddress: NFT_ADDRESS,
        subscriptionAddress: SUBSCRIPTION_ADDRESS,
        rpcUrl: RPC_URL
    });
});

// ==========================================
// GITHUB OAUTH
// ==========================================
app.get('/api/github/login', (req, res) => {
    if (!GITHUB_CLIENT_ID) {
        return res.status(500).json({ error: 'GitHub OAuth nav konfigurēts' });
    }
    const scope = 'repo read:org';
    const url = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&scope=${scope}&redirect_uri=${GITHUB_REDIRECT_URI}`;
    res.redirect(url);
});

app.get('/api/github/callback', async (req, res) => {
    const { code } = req.query;
    
    if (!code) {
        return res.redirect('/backup.html?error=no_code');
    }
    
    try {
        const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                client_id: GITHUB_CLIENT_ID,
                client_secret: GITHUB_CLIENT_SECRET,
                code: code,
                redirect_uri: GITHUB_REDIRECT_URI
            })
        });
        
        const tokenData = await tokenResponse.json();
        
        if (tokenData.access_token) {
            req.session.githubToken = tokenData.access_token;
            
            const userResponse = await fetch('https://api.github.com/user', {
                headers: {
                    'Authorization': `Bearer ${tokenData.access_token}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });
            const userData = await userResponse.json();
            req.session.githubUser = userData.login;
            req.session.githubAvatar = userData.avatar_url;
            
            res.redirect('/backup.html?auth=success');
        } else {
            res.redirect('/backup.html?error=token');
        }
    } catch (e) {
        console.error('OAuth kļūda:', e.message);
        res.redirect('/backup.html?error=oauth');
    }
});

app.get('/api/github/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/github/user', (req, res) => {
    if (req.session.githubUser) {
        res.json({
            success: true,
            user: req.session.githubUser,
            avatar: req.session.githubAvatar
        });
    } else {
        res.json({ success: false });
    }
});

// ==========================================
// IEGŪT LIETOTĀJA REPOZITORIJUS
// ==========================================
app.get('/api/github/repos', checkApiKey, async (req, res) => {
    const githubToken = req.session.githubToken;
    
    if (!githubToken) {
        return res.status(401).json({ error: 'Nav autorizēts caur GitHub' });
    }
    
    try {
        const response = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
            headers: {
                'Authorization': `Bearer ${githubToken}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });
        
        const repos = await response.json();
        
        const repoList = repos.map(repo => ({
            name: repo.full_name,
            description: repo.description,
            private: repo.private,
            language: repo.language,
            updatedAt: repo.updated_at
        }));
        
        res.json({ success: true, repos: repoList });
        
    } catch (e) {
        console.error('Repo saraksta kļūda:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// PĀRBAUDĪT REPO STATUSU (NFT un abonements)
// ==========================================
app.post('/api/check-repo-status', checkApiKey, async (req, res) => {
    try {
        const { repoName, walletAddress } = req.body;
        
        if (!repoName || !walletAddress) {
            return res.status(400).json({ error: 'Nav repo vai wallet' });
        }
        
        const provider = new ethers.JsonRpcProvider(RPC_URL);
        const repoHash = ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(['string'], [repoName])
        );
        
        const nftContract = new ethers.Contract(NFT_ADDRESS, NFT_ABI, provider);
        const tokenId = await nftContract.repositoryTokens(repoHash);
        
        let hasNFT = false;
        let hasSubscription = false;
        
        if (tokenId !== 0n && tokenId !== 0) {
            const nftOwner = await nftContract.ownerOf(tokenId);
            if (nftOwner.toLowerCase() === walletAddress.toLowerCase()) {
                hasNFT = true;
            }
        }
        
        if (hasNFT) {
            const subscriptionContract = new ethers.Contract(SUBSCRIPTION_ADDRESS, SUBSCRIPTION_ABI, provider);
            hasSubscription = await subscriptionContract.isSubscribed(tokenId);
        }
        
        res.json({
            success: true,
            hasNFT,
            hasSubscription,
            tokenId: hasNFT ? tokenId.toString() : '0'
        });
        
    } catch (e) {
        console.error('Repo statusa kļūda:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// SAGATAVOT BACKUPU
// ==========================================
app.post('/api/prepare-backup', checkApiKey, async (req, res) => {
    try {
        const { repoName, walletAddress } = req.body;
        const githubToken = req.session.githubToken;
        
        console.log('\n=== BACKUP SAGATAVOŠANA ===');
        console.log('Repo:', repoName);
        console.log('Wallet:', walletAddress);
        
        if (!repoName) return res.status(400).json({ error: 'Nav repo nosaukuma' });
        if (!walletAddress) return res.status(400).json({ error: 'Nav wallet adreses' });
        if (!githubToken) return res.status(401).json({ error: 'Nav GitHub autorizācijas' });
        
        // 1. Pārbaudīt NFT un abonementu
        const provider = new ethers.JsonRpcProvider(RPC_URL);
        const repoHash = ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(['string'], [repoName])
        );
        
        const nftContract = new ethers.Contract(NFT_ADDRESS, NFT_ABI, provider);
        const tokenId = await nftContract.repositoryTokens(repoHash);
        
        if (tokenId === 0n || tokenId === 0) {
            return res.status(400).json({ error: 'Nav NFT šim repo' });
        }
        
        const nftOwner = await nftContract.ownerOf(tokenId);
        if (nftOwner.toLowerCase() !== walletAddress.toLowerCase()) {
            return res.status(400).json({ error: 'NFT nepieder šai adresei' });
        }
        
        const subscriptionContract = new ethers.Contract(SUBSCRIPTION_ADDRESS, SUBSCRIPTION_ABI, provider);
        const isSubscribed = await subscriptionContract.isSubscribed(tokenId);
        
        if (!isSubscribed) {
            return res.status(400).json({ error: 'Nav aktīva abonementa' });
        }
        
        console.log('NFT un abonements OK');
        
        // 2. Iegūt repo failus caur GitHub API
        console.log('Iegūstam repo saturu...');
        const [owner, repo] = repoName.split('/');
        const files = await getRepoFiles(githubToken, owner, repo);
        
        if (files.length === 0) {
            return res.status(400).json({ error: 'Nav failu repo' });
        }
        
        console.log(`Iegūti ${files.length} faili`);
        
        // 3. Aprēķināt izmaksas
        const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
        
        const signer = new EthereumSigner(OPERATOR_PRIVATE_KEY);
        const turbo = TurboFactory.authenticated({
            signer,
            token: 'base-eth',
            uploadServiceConfig: { url: TURBO_UPLOAD_URL },
            paymentServiceConfig: { url: TURBO_PAYMENT_URL }
        });
        
        const costs = await turbo.getUploadCosts({ bytes: totalBytes });
        const costInfo = costs[0];
        const costWei = ethers.parseEther(costInfo.tokenAmount.toString());
        const costEth = ethers.formatEther(costWei);
        
        console.log('Izmaksas:', costEth, 'ETH');
        
        // 4. Izveidot backup ID
        const backupId = crypto.randomBytes(16).toString('hex');
        
        pendingBackups.set(backupId, {
            repoName,
            files,
            walletAddress,
            costWei: costWei.toString(),
            costEth,
            status: 'pending',
            createdAt: Date.now()
        });
        
        res.json({
            success: true,
            backupId,
            costEth,
            totalBytes,
            fileCount: files.length,
            status: 'pending'
        });
        
    } catch (e) {
        console.error('Backup sagatavošanas kļūda:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// APMAKSĀT UN IZPILDĪT BACKUPU
// ==========================================
app.post('/api/execute-backup', checkApiKey, async (req, res) => {
    try {
        const { backupId, walletAddress } = req.body;
        
        console.log('\n=== BACKUP IZPILDE ===');
        console.log('Backup ID:', backupId);
        
        const backup = pendingBackups.get(backupId);
        
        if (!backup) {
            return res.status(404).json({ error: 'Backups nav atrasts' });
        }
        
        if (backup.status === 'processing') {
            return res.status(400).json({ error: 'Backups jau tiek apstrādāts' });
        }
        
        if (backup.status === 'completed') {
            return res.status(400).json({ error: 'Backups jau pabeigts' });
        }
        
        backup.status = 'processing';
        
        // 1. Pārbaudīt Treasury bilanci
        const provider = new ethers.JsonRpcProvider(RPC_URL);
        const treasuryContract = new ethers.Contract(TREASURY_ADDRESS, TREASURY_ABI, provider);
        const treasuryBalance = await treasuryContract.balance();
        const requiredWei = BigInt(backup.costWei);
        
        console.log('Treasury:', ethers.formatEther(treasuryBalance), 'ETH');
        console.log('Nepieciešams:', ethers.formatEther(requiredWei), 'ETH');
        
        if (treasuryBalance < requiredWei) {
            backup.status = 'pending';
            return res.status(400).json({ 
                error: `Treasury nav pietiekami. Vajag ${ethers.formatEther(requiredWei)} ETH` 
            });
        }
        
        // 2. Operatora maks un payTurbo
        const operatorWallet = new ethers.Wallet(OPERATOR_PRIVATE_KEY, provider);
        const paymentId = ethers.id(backup.repoName + Date.now().toString());
        const treasuryWriteContract = new ethers.Contract(TREASURY_ADDRESS, TREASURY_ABI, operatorWallet);
        const payTx = await treasuryWriteContract.payTurbo(requiredWei, paymentId);
        await payTx.wait();
        console.log('payTurbo() veiksmīgs');
        
        // 3. Pērk kredītus
        const signer = new EthereumSigner(OPERATOR_PRIVATE_KEY);
        const turbo = TurboFactory.authenticated({
            signer,
            token: 'base-eth',
            uploadServiceConfig: { url: TURBO_UPLOAD_URL },
            paymentServiceConfig: { url: TURBO_PAYMENT_URL }
        });
        
        await turbo.topUpWithTokens({
            tokenAmount: ethers.formatEther(requiredWei)
        });
        console.log('Kredīti nopirkti');
        
        // 4. Augšupielādēt failus
        const uploadResults = [];
        
        for (let i = 0; i < backup.files.length; i++) {
            const file = backup.files[i];
            const fileBuffer = Buffer.from(file.content, 'base64');
            
            const result = await turbo.uploadFile({
                fileStreamFactory: () => fileBuffer,
                fileSizeFactory: () => fileBuffer.length,
                dataItemOpts: {
                    tags: [
                        { name: 'App-Name', value: 'PermRepo' },
                        { name: 'Repo', value: backup.repoName },
                        { name: 'File-Path', value: file.path },
                        { name: 'Content-Type', value: 'text/plain' },
                        { name: 'Unix-Time', value: String(Math.floor(Date.now() / 1000)) }
                    ]
                }
            });
            
            uploadResults.push({
                path: file.path,
                txId: result.id,
                size: file.size,
                hash: file.hash
            });
            
            console.log(`[${i + 1}/${backup.files.length}] ✅ ${file.path}`);
        }
        
        // 5. Izveidot manifestu
        const manifest = {
            manifest: 'arweave/paths',
            version: '0.2.0',
            index: { path: 'README.md' },
            paths: {},
            metadata: {
                repo: backup.repoName,
                timestamp: new Date().toISOString(),
                generatedBy: 'PermRepo v1.0.0'
            }
        };
        
        for (const f of uploadResults) {
            manifest.paths[f.path] = { id: f.txId };
        }
        
        const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8');
        const manifestResult = await turbo.uploadFile({
            fileStreamFactory: () => manifestBuffer,
            fileSizeFactory: () => manifestBuffer.length,
            dataItemOpts: {
                tags: [
                    { name: 'App-Name', value: 'PermRepo' },
                    { name: 'Type', value: 'path-manifest' },
                    { name: 'Repo', value: backup.repoName },
                    { name: 'Content-Type', value: 'application/x.arweave-manifest+json' },
                    { name: 'Unix-Time', value: String(Math.floor(Date.now() / 1000)) }
                ]
            }
        });
        
        const manifestTxId = manifestResult.id;
        console.log('Manifests:', manifestTxId);
        
        backup.status = 'completed';
        backup.manifestTxId = manifestTxId;
        backup.uploadResults = uploadResults;
        backup.completedAt = Date.now();
        
        res.json({
            success: true,
            manifestTxId,
            uploadedFiles: uploadResults,
            totalSize: backup.files.reduce((sum, f) => sum + f.size, 0),
            costEth: backup.costEth,
            status: 'completed'
        });
        
    } catch (e) {
        console.error('Backup izpildes kļūda:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// PALĪGFUNKCIJA: IEGŪT REPO FAILUS
// ==========================================
async function getRepoFiles(githubToken, owner, repo, path = '') {
    const files = [];
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    
    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${githubToken}`,
            'Accept': 'application/vnd.github.v3+json'
        }
    });
    
    if (!response.ok) {
        throw new Error(`GitHub API kļūda: ${response.status}`);
    }
    
    const contents = await response.json();
    
    for (const item of contents) {
        if (item.type === 'file') {
            if (item.size <= 104857600) {
                const fileResponse = await fetch(item.download_url, {
                    headers: {
                        'Authorization': `Bearer ${githubToken}`
                    }
                });
                const fileBuffer = await fileResponse.arrayBuffer();
                files.push({
                    path: item.path,
                    size: item.size,
                    content: Buffer.from(fileBuffer).toString('base64'),
                    hash: crypto.createHash('sha256').update(Buffer.from(fileBuffer)).digest('hex')
                });
            }
        } else if (item.type === 'dir') {
            const subFiles = await getRepoFiles(githubToken, owner, repo, item.path);
            files.push(...subFiles);
        }
    }
    
    return files;
}

// ==========================================
// VESELĪBAS PĀRBAUDE
// ==========================================
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        configured: {
            rpc: !!RPC_URL,
            operatorKey: !!OPERATOR_PRIVATE_KEY,
            treasury: !!TREASURY_ADDRESS,
            nft: !!NFT_ADDRESS,
            subscription: !!SUBSCRIPTION_ADDRESS,
            apiKey: !!API_KEY,
            githubOAuth: !!(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET)
        }
    });
});

// Statiskie faili
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'backup.html'));
});

app.listen(PORT, () => {
    console.log('========================================');
    console.log('PermRepo serveris klausās uz porta', PORT);
    console.log('========================================');
    console.log('Konfigurācija:');
    console.log('  RPC_URL:', RPC_URL ? 'IR' : 'NAV');
    console.log('  OPERATOR_PRIVATE_KEY:', OPERATOR_PRIVATE_KEY ? 'IR' : 'NAV');
    console.log('  TREASURY_ADDRESS:', TREASURY_ADDRESS || 'NAV');
    console.log('  NFT_ADDRESS:', NFT_ADDRESS || 'NAV');
    console.log('  SUBSCRIPTION_ADDRESS:', SUBSCRIPTION_ADDRESS || 'NAV');
    console.log('  GITHUB_CLIENT_ID:', GITHUB_CLIENT_ID ? 'IR' : 'NAV');
    console.log('  GITHUB_CLIENT_SECRET:', GITHUB_CLIENT_SECRET ? 'IR' : 'NAV');
    console.log('  API_KEY:', API_KEY ? 'IR' : 'NAV');
    console.log('========================================');
});
