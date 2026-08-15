import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import crypto from 'crypto';
import session from 'express-session';
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
    cookie: { secure: false, maxAge: 3600000 }
}));

app.get('/api/config', (req, res) => {
    res.json({
        chainId: CHAIN_ID,
        treasuryAddress: TREASURY_ADDRESS,
        nftAddress: NFT_ADDRESS,
        subscriptionAddress: SUBSCRIPTION_ADDRESS,
        registryAddress: REGISTRY_ADDRESS,
        rpcUrl: RPC_URL,
        arweaveGateway: ARWEAVE_GATEWAY
    });
});

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
        res.json({ success: true, user: req.session.githubUser });
    } else {
        res.json({ success: false });
    }
});

app.get('/api/github/repos', async (req, res) => {
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

app.post('/api/check-repo-status', async (req, res) => {
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
        let isRegistered = false;
        let backupCount = 0;
        let lastManifestURI = '';
        
        if (tokenId !== 0n && tokenId !== 0) {
            const nftOwner = await nftContract.ownerOf(tokenId);
            if (nftOwner.toLowerCase() === walletAddress.toLowerCase()) {
                hasNFT = true;
            }
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
                console.warn('Registry pārbaudes kļūda:', e.message);
                isRegistered = false;
            }
        }
        
        res.json({
            success: true,
            hasNFT,
            hasSubscription,
            isRegistered,
            tokenId: hasNFT ? tokenId.toString() : '0',
            backupCount,
            lastManifestURI
        });
        
    } catch (e) {
        console.error('Repo statusa kļūda:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/prepare-backup', async (req, res) => {
    try {
        const { repoName, walletAddress } = req.body;
        const githubToken = req.session.githubToken;
        
        if (!repoName) return res.status(400).json({ error: 'Nav repo nosaukuma' });
        if (!walletAddress) return res.status(400).json({ error: 'Nav wallet adreses' });
        if (!githubToken) return res.status(401).json({ error: 'Nav GitHub autorizācijas' });
        
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
        
        const registryContract = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, provider);
        const repoId = await registryContract.getRepositoryByNFT(tokenId);
        
        if (repoId === ethers.ZeroHash) {
            return res.status(400).json({ error: 'Repo nav reģistrēts Registry' });
        }
        
        let previousManifest = null;
        const backupCount = Number(await nftContract.getBackupCount(tokenId));
        
        if (backupCount > 0) {
            const manifestURI = await nftContract.getManifestURI(tokenId);
            if (manifestURI && manifestURI.startsWith('ar://')) {
                const txId = manifestURI.replace('ar://', '');
                try {
                    const manifestResponse = await fetch(`${ARWEAVE_GATEWAY}/${txId}`);
                    previousManifest = await manifestResponse.json();
                } catch (e) {
                    console.warn('Neizdevās iegūt iepriekšējo manifestu:', e.message);
                }
            }
        }
        
        const [owner, repo] = repoName.split('/');
        const currentFiles = await getRepoFiles(githubToken, owner, repo);
        
        if (currentFiles.length === 0) {
            return res.status(400).json({ error: 'Nav failu repo' });
        }
        
        const previousPaths = previousManifest?.paths || {};
        const changedFiles = [];
        const unchangedFiles = {};
        
        for (const file of currentFiles) {
            if (previousPaths[file.path] && previousPaths[file.path].id) {
                unchangedFiles[file.path] = {
                    txId: previousPaths[file.path].id,
                    size: file.size,
                    hash: file.hash
                };
            } else {
                changedFiles.push(file);
            }
        }
        
        const totalBytes = changedFiles.reduce((sum, f) => sum + f.size, 0);
        
        if (totalBytes === 0) {
            return res.json({
                success: true,
                repoName,
                tokenId: tokenId.toString(),
                files: [],
                unchangedFiles,
                fileCount: 0,
                totalBytes: 0,
                costEth: '0',
                hasPreviousBackup: backupCount > 0,
                backupCount,
                message: 'Nav izmaiņu'
            });
        }
        
        const turbo = TurboFactory.authenticated({
            privateKey: OPERATOR_PRIVATE_KEY,
            token: 'base-eth',
            uploadServiceConfig: { url: 'https://upload.services.ar-io.dev' },
            paymentServiceConfig: { url: 'https://payment.services.ar-io.dev' }
        });
        
        const costs = await turbo.getUploadCosts({ bytes: [totalBytes] });
        const costInfo = costs[0];
        const costEth = ethers.formatEther(costInfo.tokenAmount.toString());
        
        res.json({
            success: true,
            repoName,
            tokenId: tokenId.toString(),
            files: changedFiles,
            unchangedFiles,
            fileCount: changedFiles.length,
            totalBytes,
            costEth,
            hasPreviousBackup: backupCount > 0,
            backupCount
        });
        
    } catch (e) {
        console.error('Backup sagatavošanas kļūda:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/execute-backup', async (req, res) => {
    try {
        const { repoName, files, unchangedFiles, tokenId, costEth, walletAddress } = req.body;
        
        const provider = new ethers.JsonRpcProvider(RPC_URL);
        const operatorWallet = new ethers.Wallet(OPERATOR_PRIVATE_KEY, provider);
        
        const treasuryContract = new ethers.Contract(TREASURY_ADDRESS, TREASURY_ABI, provider);
        const treasuryBalance = await treasuryContract.balance();
        const costWei = ethers.parseEther(costEth);
        
        if (treasuryBalance < costWei) {
            return res.status(400).json({ error: 'Treasury nav pietiekami līdzekļu' });
        }
        
        const paymentId = ethers.id(repoName + Date.now().toString());
        const treasuryWrite = new ethers.Contract(TREASURY_ADDRESS, TREASURY_ABI, operatorWallet);
        const payTx = await treasuryWrite.payTurbo(costWei, paymentId);
        await payTx.wait();
        
        const signer = new EthereumSigner(OPERATOR_PRIVATE_KEY);
        const turbo = TurboFactory.authenticated({
            signer,
            token: 'base-eth',
            uploadServiceConfig: { url: 'https://upload.services.ar-io.dev' },
            paymentServiceConfig: { url: 'https://payment.services.ar-io.dev' }
        });
        
        await turbo.topUpWithTokens({ tokenAmount: costEth });
        
        const uploadResults = [];
        
        for (const file of files) {
            const fileBuffer = Buffer.from(file.content, 'base64');
            
            const result = await turbo.uploadFile({
                fileStreamFactory: () => fileBuffer,
                fileSizeFactory: () => fileBuffer.length,
                dataItemOpts: {
                    tags: [
                        { name: 'App-Name', value: 'PermRepo' },
                        { name: 'Repo', value: repoName },
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
        }
        
        const manifest = {
            manifest: 'arweave/paths',
            version: '0.2.0',
            index: { path: 'README.md' },
            paths: {},
            metadata: {
                repo: repoName,
                timestamp: new Date().toISOString(),
                generatedBy: 'PermRepo v1.0.0'
            }
        };
        
        for (const f of uploadResults) {
            manifest.paths[f.path] = { id: f.txId };
        }
        
        for (const [fp, info] of Object.entries(unchangedFiles)) {
            manifest.paths[fp] = { id: info.txId };
        }
        
        const manifestBuffer = Buffer.from(JSON.stringify(manifest), 'utf-8');
        const manifestResult = await turbo.uploadFile({
            fileStreamFactory: () => manifestBuffer,
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
        
        res.json({
            success: true,
            manifestTxId: manifestResult.id,
            uploadedFiles: uploadResults,
            costEth
        });
        
    } catch (e) {
        console.error('Backup izpildes kļūda:', e.message);
        res.status(500).json({ error: e.message });
    }
});

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
                    headers: { 'Authorization': `Bearer ${githubToken}` }
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
            githubOAuth: !!(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET)
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
    console.log('  OPERATOR_PRIVATE_KEY:', OPERATOR_PRIVATE_KEY ? 'IR' : 'NAV');
    console.log('  TREASURY_ADDRESS:', TREASURY_ADDRESS || 'NAV');
    console.log('========================================');
});
