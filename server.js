import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import crypto from 'crypto';
import session from 'express-session';
import { Readable } from 'stream';
import { TurboFactory, EthereumSigner } from '@ardrive/turbo-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const RPC_URL = process.env.RPC_URL;
const OPERATOR_PRIVATE_KEY = process.env.OPERATOR_PRIVATE_KEY;
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS;
const NFT_ADDRESS = process.env.NFT_ADDRESS;
const SUBSCRIPTION_ADDRESS = process.env.SUBSCRIPTION_ADDRESS;
const REGISTRY_ADDRESS = process.env.REGISTRY_ADDRESS;
const ARWEAVE_GATEWAY = process.env.ARWEAVE_GATEWAY || 'https://ar-io.dev';
const CHAIN_ID = process.env.CHAIN_ID || '0x14a34';
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const GITHUB_REDIRECT_URI = process.env.GITHUB_REDIRECT_URI;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const TURBO_TOKEN = process.env.TURBO_TOKEN || 'base-eth';
const TURBO_UPLOAD_URL = process.env.TURBO_UPLOAD_URL || 'https://upload.services.ar-io.dev';
const TURBO_PAYMENT_URL = process.env.TURBO_PAYMENT_URL || 'https://payment.services.ar-io.dev';

const NFT_ABI = [
    "function repositoryTokens(bytes32 repoHash) external view returns (uint256)",
    "function ownerOf(uint256 tokenId) external view returns (address)",
    "function getBackupCount(uint256 tokenId) external view returns (uint256)",
    "function getManifestURI(uint256 tokenId) external view returns (string)",
    "function getNonce(uint256 tokenId) external view returns (uint256)"
];

const SUBSCRIPTION_ABI = [
    "function isSubscribed(uint256 tokenId) external view returns (bool)"
];

const REGISTRY_ABI = [
    "function getRepositoryByNFT(uint256 nftTokenId) external view returns (bytes32)"
];

const TREASURY_ABI = [
    "function payTurbo(uint256 amount, bytes32 paymentId) external",
    "function balance() external view returns (uint256)"
];

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false, httpOnly: true, maxAge: 3600000 }
}));

function getProvider() {
    if (!RPC_URL) throw new Error('RPC_URL nav konfigurēts');
    return new ethers.JsonRpcProvider(RPC_URL);
}

function getOperatorWallet(provider) {
    if (!OPERATOR_PRIVATE_KEY) throw new Error('OPERATOR_PRIVATE_KEY nav konfigurēts');
    return new ethers.Wallet(OPERATOR_PRIVATE_KEY, provider);
}

function getTurbo() {
    if (!OPERATOR_PRIVATE_KEY) throw new Error('OPERATOR_PRIVATE_KEY nav konfigurēts');
    return TurboFactory.authenticated({
        signer: new EthereumSigner(OPERATOR_PRIVATE_KEY),
        token: TURBO_TOKEN,
        gatewayUrl: 'https://sepolia.base.org',
        uploadServiceConfig: { url: TURBO_UPLOAD_URL },
        paymentServiceConfig: { url: TURBO_PAYMENT_URL }
    });
}

function errorMessage(error) {
    return error && typeof error.message === 'string' ? error.message : String(error);
}

function getRepositoryHash(repoName) {
    return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['string'], [repoName]));
}

app.get('/api/config', (req, res) => {
    res.json({
        chainId: CHAIN_ID,
        treasuryAddress: TREASURY_ADDRESS,
        nftAddress: NFT_ADDRESS,
        subscriptionAddress: SUBSCRIPTION_ADDRESS,
        registryAddress: REGISTRY_ADDRESS,
        rpcUrl: RPC_URL,
        arweaveGateway: ARWEAVE_GATEWAY,
        turboToken: TURBO_TOKEN
    });
});

app.get('/api/github/login', (req, res) => {
    if (!GITHUB_CLIENT_ID) return res.status(500).json({ success: false, error: 'GitHub OAuth nav konfigurēts' });
    if (!GITHUB_REDIRECT_URI) return res.status(500).json({ success: false, error: 'GITHUB_REDIRECT_URI nav konfigurēts' });
    const scope = 'repo read:org';
    const params = new URLSearchParams({ client_id: GITHUB_CLIENT_ID, scope, redirect_uri: GITHUB_REDIRECT_URI });
    res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
});

app.get('/api/github/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.redirect('/backup.html?error=no_code');
    
    try {
        const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code, redirect_uri: GITHUB_REDIRECT_URI })
        });
        
        if (!tokenResponse.ok) throw new Error(`GitHub OAuth token HTTP ${tokenResponse.status}`);
        const tokenData = await tokenResponse.json();
        
        if (!tokenData.access_token) return res.redirect('/backup.html?error=token');
        
        req.session.githubToken = tokenData.access_token;
        
        const userResponse = await fetch('https://api.github.com/user', {
            headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/vnd.github.v3+json' }
        });
        
        if (!userResponse.ok) throw new Error(`GitHub user API kļūda: ${userResponse.status}`);
        const userData = await userResponse.json();
        
        req.session.githubUser = userData.login;
        req.session.githubAvatar = userData.avatar_url;
        
        res.redirect('/backup.html?auth=success');
    } catch (error) {
        console.error('OAuth kļūda:', error);
        res.redirect('/backup.html?error=oauth');
    }
});

app.get('/api/github/logout', (req, res) => {
    req.session.destroy(() => { res.json({ success: true }); });
});

app.get('/api/github/user', (req, res) => {
    if (req.session.githubUser) {
        res.json({ success: true, user: req.session.githubUser, avatar: req.session.githubAvatar || null });
    } else {
        res.json({ success: false });
    }
});

app.get('/api/github/repos', async (req, res) => {
    const githubToken = req.session.githubToken;
    if (!githubToken) return res.status(401).json({ success: false, error: 'Nav autorizēts caur GitHub' });
    
    try {
        const response = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
            headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github.v3+json' }
        });
        
        if (!response.ok) throw new Error(`GitHub API kļūda: ${response.status}`);
        const repos = await response.json();
        
        const repoList = repos.map(repo => ({
            name: repo.full_name,
            description: repo.description,
            private: repo.private,
            language: repo.language,
            updatedAt: repo.updated_at
        }));
        
        res.json({ success: true, repos: repoList });
    } catch (error) {
        res.status(500).json({ success: false, error: errorMessage(error) });
    }
});

app.post('/api/check-repo-status', async (req, res) => {
    try {
        const { repoName, walletAddress } = req.body;
        if (!repoName || !walletAddress) return res.status(400).json({ success: false, error: 'Nav repo vai wallet' });
        
        const provider = getProvider();
        const repoHash = getRepositoryHash(repoName);
        const nftContract = new ethers.Contract(NFT_ADDRESS, NFT_ABI, provider);
        const tokenId = await nftContract.repositoryTokens(repoHash);
        
        let hasNFT = false;
        let hasSubscription = false;
        let isRegistered = false;
        let backupCount = 0;
        let lastManifestURI = '';
        
        if (tokenId !== 0n) {
            const nftOwner = await nftContract.ownerOf(tokenId);
            if (nftOwner.toLowerCase() === walletAddress.toLowerCase()) hasNFT = true;
        }
        
        if (hasNFT) {
            const subscriptionContract = new ethers.Contract(SUBSCRIPTION_ADDRESS, SUBSCRIPTION_ABI, provider);
            hasSubscription = await subscriptionContract.isSubscribed(tokenId);
            
            backupCount = Number(await nftContract.getBackupCount(tokenId));
            lastManifestURI = await nftContract.getManifestURI(tokenId);
            
            const registryContract = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, provider);
            try {
                const repoId = await registryContract.getRepositoryByNFT(tokenId);
                isRegistered = repoId !== ethers.ZeroHash;
            } catch (e) {
                console.warn('Registry pārbaudes kļūda:', errorMessage(e));
            }
        }
        
        res.json({ success: true, hasNFT, hasSubscription, isRegistered, tokenId: hasNFT ? tokenId.toString() : '0', backupCount, lastManifestURI });
    } catch (error) {
        res.status(500).json({ success: false, error: errorMessage(error) });
    }
});

app.post('/api/prepare-backup', async (req, res) => {
    try {
        const { repoName, walletAddress } = req.body;
        const githubToken = req.session.githubToken;
        
        if (!repoName) return res.status(400).json({ success: false, error: 'Nav repo nosaukuma' });
        if (!walletAddress) return res.status(400).json({ success: false, error: 'Nav wallet adreses' });
        if (!githubToken) return res.status(401).json({ success: false, error: 'Nav GitHub autorizācijas' });
        
        const provider = getProvider();
        const repoHash = getRepositoryHash(repoName);
        const nftContract = new ethers.Contract(NFT_ADDRESS, NFT_ABI, provider);
        const tokenId = await nftContract.repositoryTokens(repoHash);
        
        if (tokenId === 0n) return res.status(400).json({ success: false, error: 'Nav NFT šim repo' });
        
        const nftOwner = await nftContract.ownerOf(tokenId);
        if (nftOwner.toLowerCase() !== walletAddress.toLowerCase()) return res.status(403).json({ success: false, error: 'NFT nepieder šai adresei' });
        
        const subscriptionContract = new ethers.Contract(SUBSCRIPTION_ADDRESS, SUBSCRIPTION_ABI, provider);
        if (!(await subscriptionContract.isSubscribed(tokenId))) return res.status(400).json({ success: false, error: 'Nav aktīva abonementa' });
        
        const registryContract = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, provider);
        const repoId = await registryContract.getRepositoryByNFT(tokenId);
        if (repoId === ethers.ZeroHash) return res.status(400).json({ success: false, error: 'Repo nav reģistrēts Registry' });
        
        const backupCount = Number(await nftContract.getBackupCount(tokenId));
        
        // Nelasam iepriekšējo manifestu — testēšanai vienkārši backupējam visu
        const previousPaths = {};
        
        const repoParts = repoName.split('/');
        if (repoParts.length !== 2) return res.status(400).json({ success: false, error: 'Repo jābūt owner/repository formātā' });
        
        const currentFiles = await getRepoFiles(githubToken, repoParts[0], repoParts[1]);
        if (currentFiles.length === 0) return res.status(400).json({ success: false, error: 'Nav failu repo' });
        
        const changedFiles = currentFiles;
        const unchangedFiles = {};
        
        const totalBytes = changedFiles.reduce((sum, file) => sum + Number(file.size || 0), 0);
        
        const turbo = getTurbo();
        let costWinc = 0n;
        let costEth = '0';
        
        const costs = await turbo.getUploadCosts({ bytes: [totalBytes] });
        if (Array.isArray(costs) && costs.length > 0 && costs[0].winc !== undefined) {
            costWinc = BigInt(String(costs[0].winc));
        }
        
        try {
            const { tokenPrice } = await turbo.getTokenPriceForBytes({ byteCount: totalBytes });
            costEth = tokenPrice.toString();
        } catch (e) {
            console.warn('Neizdevās iegūt ETH cenu:', errorMessage(e));
        }
        
        const costWei = ethers.parseEther(costEth);
        let treasuryBalance = 0n;
        if (TREASURY_ADDRESS) {
            const treasuryContract = new ethers.Contract(TREASURY_ADDRESS, TREASURY_ABI, provider);
            treasuryBalance = await treasuryContract.balance();
        }
        const hasEnoughTreasury = treasuryBalance >= costWei;
        
        return res.json({
            success: true,
            repoName,
            tokenId: tokenId.toString(),
            files: changedFiles.map(file => ({ path: file.path, size: file.size, hash: file.hash, content: file.content })),
            unchangedFiles,
            fileCount: changedFiles.length,
            totalBytes,
            costWinc: costWinc.toString(),
            costEth,
            treasuryBalance: treasuryBalance.toString(),
            hasEnoughTreasury,
            hasPreviousBackup: backupCount > 0,
            backupCount
        });
        
    } catch (error) {
        console.error('BACKUP PREPARE ERROR', error);
        return res.status(500).json({ success: false, error: errorMessage(error) });
    }
});

app.post('/api/execute-backup', async (req, res) => {
    try {
        const { repoName, files, unchangedFiles, tokenId, costEth, walletAddress } = req.body;
        
        if (!repoName) return res.status(400).json({ success: false, error: 'Nav repoName' });
        if (!walletAddress) return res.status(400).json({ success: false, error: 'Nav walletAddress' });
        if (!Array.isArray(files)) return res.status(400).json({ success: false, error: 'files nav masīvs' });
        if (!tokenId) return res.status(400).json({ success: false, error: 'Nav tokenId' });
        if (!costEth) return res.status(400).json({ success: false, error: 'Nav costEth' });
        
        const provider = getProvider();
        
        const nftContract = new ethers.Contract(NFT_ADDRESS, NFT_ABI, provider);
        const repoHash = getRepositoryHash(repoName);
        const onChainTokenId = await nftContract.repositoryTokens(repoHash);
        
        if (onChainTokenId === 0n) return res.status(400).json({ success: false, error: 'Repo NFT vairs nepastāv' });
        
        const nftOwner = await nftContract.ownerOf(onChainTokenId);
        if (nftOwner.toLowerCase() !== walletAddress.toLowerCase()) return res.status(403).json({ success: false, error: 'NFT nepieder wallet adresei' });
        
        const subscriptionContract = new ethers.Contract(SUBSCRIPTION_ADDRESS, SUBSCRIPTION_ABI, provider);
        if (!(await subscriptionContract.isSubscribed(onChainTokenId))) return res.status(400).json({ success: false, error: 'Abonements vairs nav aktīvs' });
        
        const registryContract = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, provider);
        const repoId = await registryContract.getRepositoryByNFT(onChainTokenId);
        if (repoId === ethers.ZeroHash) return res.status(400).json({ success: false, error: 'Repo nav reģistrēts Registry' });
        
        // 1. payTurbo no Treasury
        const operatorWallet = getOperatorWallet(provider);
        const treasuryWrite = new ethers.Contract(TREASURY_ADDRESS, TREASURY_ABI, operatorWallet);
        const costWei = ethers.parseEther(costEth);
        const paymentId = ethers.id(repoName + Date.now().toString());
        
        const payTx = await treasuryWrite.payTurbo(costWei, paymentId);
        await payTx.wait();
        console.log('✅ Treasury payTurbo veiksmīgs:', payTx.hash);
        
        // 2. Pagaida, kamēr Turbo apstrādā maksājumu
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // 3. Augšupielādē failus
        const turbo = getTurbo();
        const uploadResults = [];
        
        for (const file of files) {
            if (!file.path || !file.content) throw new Error(`Nederīgs fails: ${file.path}`);
            
            const fileBuffer = Buffer.from(file.content, 'base64');
            console.log('Augšupielādē:', file.path);
            
            const result = await turbo.uploadFile({
                fileStreamFactory: () => Readable.from(fileBuffer),
                fileSizeFactory: () => fileBuffer.length,
                dataItemOpts: {
                    tags: [
                        { name: 'App-Name', value: 'PermRepo' },
                        { name: 'Repo', value: repoName },
                        { name: 'File-Path', value: file.path },
                        { name: 'Content-Type', value: getContentType(file.path) },
                        { name: 'Content-SHA256', value: file.hash || crypto.createHash('sha256').update(fileBuffer).digest('hex') },
                        { name: 'Unix-Time', value: String(Math.floor(Date.now() / 1000)) }
                    ]
                }
            });
            
            if (!result || !result.id) throw new Error(`Turbo neatgrieza ID failam: ${file.path}`);
            
            uploadResults.push({
                path: file.path,
                txId: result.id,
                size: fileBuffer.length,
                hash: file.hash || crypto.createHash('sha256').update(fileBuffer).digest('hex')
            });
        }
        
        // 4. Manifests
        const manifest = {
            manifest: 'arweave/paths',
            version: '0.2.0',
            paths: {},
            metadata: { repo: repoName, timestamp: new Date().toISOString(), generatedBy: 'PermRepo v1.0.0' }
        };
        
        for (const file of uploadResults) {
            manifest.paths[file.path] = { id: file.txId };
        }
        
        for (const [filePath, info] of Object.entries(unchangedFiles || {})) {
            if (info && info.txId) manifest.paths[filePath] = { id: info.txId };
        }
        
        const manifestPaths = Object.keys(manifest.paths);
        if (manifestPaths.length > 0) {
            manifest.index = { path: manifest.paths['README.md'] ? 'README.md' : manifestPaths[0] };
        }
        
        const manifestBuffer = Buffer.from(JSON.stringify(manifest), 'utf8');
        console.log('Augšupielādē manifestu...');
        
        const manifestResult = await turbo.uploadFile({
            fileStreamFactory: () => Readable.from(manifestBuffer),
            fileSizeFactory: () => manifestBuffer.length,
            dataItemOpts: {
                tags: [
                    { name: 'App-Name', value: 'PermRepo' },
                    { name: 'Type', value: 'path-manifest' },
                    { name: 'Repo', value: repoName },
                    { name: 'Content-Type', value: 'application/x.arweave-manifest+json' },
                    { name: 'Unix-Time', value: String(Math.floor(Date.now() / 1000)) }
                ]
            }
        });
        
        if (!manifestResult || !manifestResult.id) throw new Error('Turbo neatgrieza manifest ID');
        
        return res.json({
            success: true,
            manifestTxId: manifestResult.id,
            uploadedFiles: uploadResults,
            costEth,
            paymentTx: payTx.hash
        });
        
    } catch (error) {
        console.error('BACKUP EXECUTE ERROR', error);
        return res.status(500).json({ success: false, error: errorMessage(error) });
    }
});

function getContentType(filePath) {
    const lower = filePath.toLowerCase();
    if (lower.endsWith('.json')) return 'application/json';
    if (lower.endsWith('.html')) return 'text/html';
    if (lower.endsWith('.css')) return 'text/css';
    if (lower.endsWith('.js') || lower.endsWith('.mjs')) return 'application/javascript';
    if (lower.endsWith('.ts')) return 'text/plain';
    if (lower.endsWith('.md')) return 'text/markdown';
    if (lower.endsWith('.xml')) return 'application/xml';
    if (lower.endsWith('.svg')) return 'image/svg+xml';
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.gif')) return 'image/gif';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.pdf')) return 'application/pdf';
    return 'application/octet-stream';
}

async function getRepoFiles(githubToken, owner, repo, repoPath = '') {
    const files = [];
    const encodedPath = repoPath ? repoPath.split('/').map(part => encodeURIComponent(part)).join('/') : '';
    const url = encodedPath
        ? `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`
        : `https://api.github.com/repos/${owner}/${repo}/contents`;
    
    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${githubToken}`,
            Accept: 'application/vnd.github.v3+json',
            'X-GitHub-Api-Version': '2022-11-28'
        }
    });
    
    if (!response.ok) throw new Error(`GitHub API kļūda: ${response.status}`);
    
    const contents = await response.json();
    if (!Array.isArray(contents)) return files;
    
    for (const item of contents) {
        if (item.type === 'file') {
            const size = Number(item.size || 0);
            if (size > 104857600) continue;
            if (!item.download_url) continue;
            
            const fileResponse = await fetch(item.download_url, {
                headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/octet-stream' }
            });
            
            if (!fileResponse.ok) continue;
            
            const fileBuffer = Buffer.from(await fileResponse.arrayBuffer());
            const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
            
            files.push({ path: item.path, size: fileBuffer.length, content: fileBuffer.toString('base64'), hash });
        } else if (item.type === 'dir') {
            const subFiles = await getRepoFiles(githubToken, owner, repo, item.path);
            files.push(...subFiles);
        }
    }
    
    return files;
}

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        configured: {
            rpc: !!RPC_URL,
            operatorKey: !!OPERATOR_PRIVATE_KEY,
            treasury: !!TREASURY_ADDRESS,
            nft: !!NFT_ADDRESS,
            subscription: !!SUBSCRIPTION_ADDRESS,
            registry: !!REGISTRY_ADDRESS,
            githubOAuth: !!(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET && GITHUB_REDIRECT_URI)
        }
    });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'backup.html'));
});

app.listen(PORT, () => {
    console.log('========================================');
    console.log('PermRepo serveris klausās uz porta', PORT);
    console.log('========================================');
    console.log('RPC_URL:', RPC_URL ? 'IR' : 'NAV');
    console.log('OPERATOR_PRIVATE_KEY:', OPERATOR_PRIVATE_KEY ? 'IR' : 'NAV');
    console.log('TREASURY_ADDRESS:', TREASURY_ADDRESS || 'NAV');
    console.log('NFT_ADDRESS:', NFT_ADDRESS || 'NAV');
    console.log('SUBSCRIPTION_ADDRESS:', SUBSCRIPTION_ADDRESS || 'NAV');
    console.log('REGISTRY_ADDRESS:', REGISTRY_ADDRESS || 'NAV');
    console.log('TURBO_TOKEN:', TURBO_TOKEN);
    console.log('========================================');
});
