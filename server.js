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

// ============================================================
// LOGĒŠANAS PALĪGFUNKCIJAS
// ============================================================

function logSection(title) {
    console.log('\n' + '='.repeat(60));
    console.log(title);
    console.log('='.repeat(60));
}

function logInfo(label, value) {
    console.log(`   ${label}: ${value}`);
}

function logSuccess(message) {
    console.log(`   ✅ ${message}`);
}

function logError(message) {
    console.log(`   ❌ ${message}`);
}

function logWarning(message) {
    console.log(`   ⚠️ ${message}`);
}

// ============================================================
// ABIs
// ============================================================

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

// ============================================================
// EXPRESS
// ============================================================

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false, httpOnly: true, maxAge: 3600000 }
}));

// ============================================================
// PROVIDER
// ============================================================

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

// ============================================================
// IZMAKSU APRĒĶINS
// ============================================================

async function getWincForBytes(turbo, byteSizes) {
    if (!Array.isArray(byteSizes) || byteSizes.length === 0) {
        return { totalWinc: 0n, perFileWinc: [] };
    }
    
    logSection('⚡ TURBO getUploadCosts');
    logInfo('Failu izmēri', byteSizes.join(', ') + ' bytes');
    
    const costs = await turbo.getUploadCosts({ bytes: byteSizes });
    
    let totalWinc = 0n;
    const perFileWinc = [];
    
    for (let i = 0; i < costs.length; i++) {
        const winc = BigInt(String(costs[i]?.winc || '0'));
        perFileWinc.push(winc);
        totalWinc += winc;
        logInfo(`Fails #${i + 1}`, `${byteSizes[i]} bytes → ${winc} winc`);
    }
    
    logInfo('Kopējais Winc', totalWinc.toString());
    logInfo('Bezmaksas', totalWinc === 0n ? '✅ JĀ' : '❌ NĒ');
    
    return { totalWinc, perFileWinc };
}

async function getEthForBytes(turbo, totalBytes) {
    if (totalBytes <= 0) {
        return '0';
    }
    
    logSection('💰 TURBO IZMAKSU APRĒĶINS');
    logInfo('Izmērs', totalBytes + ' bytes');
    
    try {
        const { totalWinc } = await getWincForBytes(turbo, [totalBytes]);
        if (totalWinc === 0n) {
            logSuccess('Bezmaksas augšupielāde!');
            return '0';
        }
    } catch (e) {
        logWarning('getUploadCosts kļūda: ' + errorMessage(e));
    }
    
    const { tokenPrice } = await turbo.getTokenPriceForBytes({ byteCount: totalBytes });
    const costEth = String(tokenPrice);
    
    logInfo('ETH cena', costEth + ' ETH');
    logInfo('Wei cena', ethers.parseEther(costEth).toString() + ' wei');
    
    return costEth;
}

// ============================================================
// CONFIG
// ============================================================

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

// ============================================================
// GITHUB OAUTH
// ============================================================

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
        logSection('🔐 GITHUB OAUTH');
        logInfo('Code', code ? 'saņemts' : 'nav');
        
        const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code, redirect_uri: GITHUB_REDIRECT_URI })
        });
        
        if (!tokenResponse.ok) throw new Error(`GitHub OAuth token HTTP ${tokenResponse.status}`);
        const tokenData = await tokenResponse.json();
        
        if (!tokenData.access_token) {
            logError('Netika saņemts access_token');
            return res.redirect('/backup.html?error=token');
        }
        
        logSuccess('Access token saņemts');
        req.session.githubToken = tokenData.access_token;
        
        const userResponse = await fetch('https://api.github.com/user', {
            headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/vnd.github.v3+json' }
        });
        
        if (!userResponse.ok) throw new Error(`GitHub user API kļūda: ${userResponse.status}`);
        const userData = await userResponse.json();
        
        req.session.githubUser = userData.login;
        req.session.githubAvatar = userData.avatar_url;
        
        logSuccess('Lietotājs: ' + userData.login);
        res.redirect('/backup.html?auth=success');
    } catch (error) {
        logError('OAuth kļūda: ' + errorMessage(error));
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

// ============================================================
// GITHUB REPOS
// ============================================================

app.get('/api/github/repos', async (req, res) => {
    const githubToken = req.session.githubToken;
    if (!githubToken) return res.status(401).json({ success: false, error: 'Nav autorizēts caur GitHub' });
    
    try {
        const startTime = Date.now();
        const response = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
            headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github.v3+json' }
        });
        const elapsed = Date.now() - startTime;
        
        if (!response.ok) throw new Error(`GitHub API kļūda: ${response.status}`);
        const repos = await response.json();
        
        logSection('🌐 GITHUB REPOS');
        logInfo('Statuss', response.status);
        logInfo('Laiks', elapsed + 'ms');
        logInfo('Repo skaits', repos.length);
        
        const repoList = repos.map(repo => ({
            name: repo.full_name,
            description: repo.description,
            private: repo.private,
            language: repo.language,
            updatedAt: repo.updated_at
        }));
        
        res.json({ success: true, repos: repoList });
    } catch (error) {
        logError('Repo saraksta kļūda: ' + errorMessage(error));
        res.status(500).json({ success: false, error: errorMessage(error) });
    }
});

// ============================================================
// CHECK REPO STATUS
// ============================================================

app.post('/api/check-repo-status', async (req, res) => {
    try {
        const { repoName, walletAddress } = req.body;
        
        logSection('🔍 REPO STATUS PĀRBAUDE');
        logInfo('Repo', repoName);
        logInfo('Wallet', walletAddress);
        
        if (!repoName || !walletAddress) {
            logError('Nav repo vai wallet');
            return res.status(400).json({ success: false, error: 'Nav repo vai wallet' });
        }
        
        const provider = getProvider();
        const repoHash = getRepositoryHash(repoName);
        logInfo('Repo hash', repoHash);
        
        const nftContract = new ethers.Contract(NFT_ADDRESS, NFT_ABI, provider);
        const tokenId = await nftContract.repositoryTokens(repoHash);
        logInfo('Token ID', tokenId.toString());
        
        let hasNFT = false;
        let hasSubscription = false;
        let isRegistered = false;
        let backupCount = 0;
        let lastManifestURI = '';
        
        if (tokenId !== 0n) {
            const nftOwner = await nftContract.ownerOf(tokenId);
            logInfo('NFT īpašnieks', nftOwner);
            
            if (nftOwner.toLowerCase() === walletAddress.toLowerCase()) {
                hasNFT = true;
                logSuccess('NFT īpašnieks apstiprināts');
            } else {
                logError('NFT īpašnieks NEATBILST');
            }
        } else {
            logWarning('NFT nav atrasts');
        }
        
        if (hasNFT) {
            const subscriptionContract = new ethers.Contract(SUBSCRIPTION_ADDRESS, SUBSCRIPTION_ABI, provider);
            hasSubscription = await subscriptionContract.isSubscribed(tokenId);
            logInfo('Abonements', hasSubscription ? '✅ Aktīvs' : '❌ Nav aktīvs');
            
            backupCount = Number(await nftContract.getBackupCount(tokenId));
            logInfo('Backup count', backupCount);
            
            lastManifestURI = await nftContract.getManifestURI(tokenId);
            logInfo('Pēdējais manifests', lastManifestURI);
            
            const registryContract = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, provider);
            try {
                const repoId = await registryContract.getRepositoryByNFT(tokenId);
                isRegistered = repoId !== ethers.ZeroHash;
                logInfo('Reģistrācija', isRegistered ? '✅ Reģistrēts' : '❌ Nav reģistrēts');
            } catch (e) {
                logWarning('Registry pārbaudes kļūda: ' + errorMessage(e));
            }
        }
        
        res.json({ success: true, hasNFT, hasSubscription, isRegistered, tokenId: hasNFT ? tokenId.toString() : '0', backupCount, lastManifestURI });
    } catch (error) {
        logError('Statusa kļūda: ' + errorMessage(error));
        res.status(500).json({ success: false, error: errorMessage(error) });
    }
});

// ============================================================
// PREPARE BACKUP
// ============================================================

app.post('/api/prepare-backup', async (req, res) => {
    try {
        const { repoName, walletAddress } = req.body;
        const githubToken = req.session.githubToken;
        
        logSection('📥 PREPARE BACKUP');
        logInfo('Repo', repoName);
        logInfo('Wallet', walletAddress);
        
        if (!repoName) return res.status(400).json({ success: false, error: 'Nav repo nosaukuma' });
        if (!walletAddress) return res.status(400).json({ success: false, error: 'Nav wallet adreses' });
        if (!githubToken) return res.status(401).json({ success: false, error: 'Nav GitHub autorizācijas' });
        
        const provider = getProvider();
        const repoHash = getRepositoryHash(repoName);
        const nftContract = new ethers.Contract(NFT_ADDRESS, NFT_ABI, provider);
        const tokenId = await nftContract.repositoryTokens(repoHash);
        
        logSection('🔍 NFT PĀRBAUDE');
        if (tokenId === 0n) {
            logError('Nav NFT šim repo');
            return res.status(400).json({ success: false, error: 'Nav NFT šim repo' });
        }
        logInfo('Token ID', tokenId.toString());
        
        const nftOwner = await nftContract.ownerOf(tokenId);
        if (nftOwner.toLowerCase() !== walletAddress.toLowerCase()) {
            logError('NFT nepieder šai adresei');
            return res.status(403).json({ success: false, error: 'NFT nepieder šai adresei' });
        }
        logSuccess('NFT īpašnieks OK');
        
        logSection('📅 ABONEMENTA PĀRBAUDE');
        const subscriptionContract = new ethers.Contract(SUBSCRIPTION_ADDRESS, SUBSCRIPTION_ABI, provider);
        if (!(await subscriptionContract.isSubscribed(tokenId))) {
            logError('Nav aktīva abonementa');
            return res.status(400).json({ success: false, error: 'Nav aktīva abonementa' });
        }
        logSuccess('Abonements aktīvs');
        
        logSection('📋 REGISTRY PĀRBAUDE');
        const registryContract = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, provider);
        const repoId = await registryContract.getRepositoryByNFT(tokenId);
        if (repoId === ethers.ZeroHash) {
            logError('Repo nav reģistrēts Registry');
            return res.status(400).json({ success: false, error: 'Repo nav reģistrēts Registry' });
        }
        logSuccess('Repo reģistrēts');
        
        const backupCount = Number(await nftContract.getBackupCount(tokenId));
        logInfo('Backup count', backupCount);
        
        let previousPaths = {};
        let previousHistory = [];
        let previousManifestId = null;
        let previousBackupNumber = null;
        
        if (backupCount > 0) {
            logSection('📜 IEPRIEKŠĒJAIS MANIFESTS');
            const manifestURI = await nftContract.getManifestURI(tokenId);
            logInfo('URI', manifestURI);
            
            if (manifestURI && manifestURI.startsWith('ar://')) {
                previousManifestId = manifestURI.slice(5);
                logInfo('Manifest ID', previousManifestId);
                
                try {
                    const startTime = Date.now();
                    const manifestResponse = await fetch(`${ARWEAVE_GATEWAY}/raw/${previousManifestId}`);
                    const elapsed = Date.now() - startTime;
                    
                    if (manifestResponse.ok) {
                        const previousManifest = await manifestResponse.json();
                        if (previousManifest.paths) previousPaths = previousManifest.paths;
                        if (previousManifest.history) previousHistory = previousManifest.history;
                        if (previousManifest.metadata && previousManifest.metadata.backupNumber) previousBackupNumber = previousManifest.metadata.backupNumber;
                        
                        logInfo('Faili', Object.keys(previousPaths).length);
                        logInfo('Vēstures ieraksti', previousHistory.length);
                        logInfo('Lejupielādes laiks', elapsed + 'ms');
                        logSuccess('Iepriekšējais manifests iegūts');
                    }
                } catch (e) {
                    logWarning('Neizdevās iegūt iepriekšējo manifestu: ' + errorMessage(e));
                }
            }
        }
        
        logSection('🌐 GITHUB FAILI');
        const repoParts = repoName.split('/');
        const startTime = Date.now();
        const currentFiles = await getRepoFiles(githubToken, repoParts[0], repoParts[1]);
        const elapsed = Date.now() - startTime;
        
        if (currentFiles.length === 0) {
            logError('Nav failu repo');
            return res.status(400).json({ success: false, error: 'Nav failu repo' });
        }
        logInfo('Kopā faili', currentFiles.length);
        logInfo('Laiks', elapsed + 'ms');
        
        const changedFiles = [];
        const unchangedFiles = {};
        
        for (const file of currentFiles) {
            const previousFile = previousPaths[file.path];
            if (previousFile && previousFile.id && previousFile.hash && previousFile.hash === file.hash) {
                unchangedFiles[file.path] = { txId: previousFile.id, size: file.size, hash: file.hash };
            } else {
                changedFiles.push(file);
            }
        }
        
        logInfo('Mainīti', changedFiles.length);
        logInfo('Nemainīti', Object.keys(unchangedFiles).length);
        
        if (changedFiles.length === 0) {
            logSuccess('Nav izmaiņu');
            return res.json({
                success: true,
                repoName,
                tokenId: tokenId.toString(),
                files: [],
                unchangedFiles,
                fileCount: 0,
                totalBytes: 0,
                fileWinc: '0',
                fileCostEth: '0',
                treasuryBalance: '0',
                hasEnoughTreasury: true,
                hasPreviousBackup: backupCount > 0,
                backupCount,
                message: 'Nav izmaiņu'
            });
        }
        
        for (const file of changedFiles) {
            logInfo(`Mainīts: ${file.path}`, `${file.size} bytes`);
        }
        
        logSection('⚡ TURBO IZMAKSAS');
        const turbo = getTurbo();
        
        const fileSizes = changedFiles.map(file => file.size);
        const { totalWinc: fileWinc } = await getWincForBytes(turbo, fileSizes);
        const totalFileBytes = changedFiles.reduce((sum, file) => sum + file.size, 0);
        const fileCostEth = await getEthForBytes(turbo, totalFileBytes);
        
        logSection('🏦 TREASURY');
        let treasuryBalance = 0n;
        if (TREASURY_ADDRESS) {
            const treasuryContract = new ethers.Contract(TREASURY_ADDRESS, TREASURY_ABI, provider);
            treasuryBalance = await treasuryContract.balance();
        }
        logInfo('Bilance', ethers.formatEther(treasuryBalance) + ' ETH');
        
        const fileCostWei = ethers.parseEther(fileCostEth);
        const hasEnoughTreasury = fileCostWei === 0n ? true : treasuryBalance >= fileCostWei;
        logInfo('Nepieciešams', fileCostEth + ' ETH');
        logInfo('Pietiekami', hasEnoughTreasury ? '✅ JĀ' : '❌ NĒ');
        
        return res.json({
            success: true,
            repoName,
            tokenId: tokenId.toString(),
            files: changedFiles.map(file => ({ path: file.path, size: file.size, hash: file.hash, content: file.content })),
            unchangedFiles,
            previousHistory,
            previousManifestId,
            previousBackupNumber,
            fileCount: changedFiles.length,
            totalBytes: totalFileBytes,
            fileWinc: fileWinc.toString(),
            fileCostEth,
            treasuryBalance: treasuryBalance.toString(),
            hasEnoughTreasury,
            hasPreviousBackup: backupCount > 0,
            backupCount
        });
        
    } catch (error) {
        logSection('❌ BACKUP PREPARE ERROR');
        logError(errorMessage(error));
        console.error(error);
        return res.status(500).json({ success: false, error: errorMessage(error) });
    }
});

// ============================================================
// EXECUTE BACKUP
// ============================================================

app.post('/api/execute-backup', async (req, res) => {
    try {
        const { repoName, files, unchangedFiles, tokenId, fileCostEth, walletAddress, previousHistory, previousManifestId, previousBackupNumber } = req.body;
        
        logSection('📤 EXECUTE BACKUP');
        logInfo('Repo', repoName);
        logInfo('Faili', files.length);
        logInfo('Token ID', tokenId);
        logInfo('Failu izmaksas', fileCostEth + ' ETH');
        
        if (!repoName) return res.status(400).json({ success: false, error: 'Nav repoName' });
        if (!walletAddress) return res.status(400).json({ success: false, error: 'Nav walletAddress' });
        if (!Array.isArray(files)) return res.status(400).json({ success: false, error: 'files nav masīvs' });
        if (!tokenId) return res.status(400).json({ success: false, error: 'Nav tokenId' });
        if (!fileCostEth) return res.status(400).json({ success: false, error: 'Nav fileCostEth' });
        
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
        
        const turbo = getTurbo();
        
        // 1. FAILU APMAKSA
        const fileCostWei = ethers.parseEther(fileCostEth);
        
        logSection('💳 FAILU APMAKSA');
        if (fileCostWei > 0n) {
            logInfo('Summa', fileCostEth + ' ETH');
            
            const operatorWallet = getOperatorWallet(provider);
            const treasuryWrite = new ethers.Contract(TREASURY_ADDRESS, TREASURY_ABI, operatorWallet);
            const filePaymentId = ethers.id(repoName + '-files-' + Date.now().toString());
            const filePayTx = await treasuryWrite.payTurbo(fileCostWei, filePaymentId);
            await filePayTx.wait();
            
            logSuccess('Transakcija: ' + filePayTx.hash);
            logInfo('Payment ID', filePaymentId);
            
            await new Promise(resolve => setTimeout(resolve, 5000));
            logSuccess('Gaidīšana pabeigta (5s)');
        } else {
            logSuccess('Faili ir bezmaksas!');
        }
        
        // 2. FAILU AUGŠUPIELĀDE
        logSection('📤 FAILU AUGŠUPIELĀDE');
        const uploadResults = [];
        
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const fileBuffer = Buffer.from(file.content, 'base64');
            
            logInfo(`[${i + 1}/${files.length}] ${file.path}`, fileBuffer.length + ' bytes');
            
            const startUpload = Date.now();
            const result = await turbo.uploadFile({
                fileStreamFactory: () => Readable.from(fileBuffer),
                fileSizeFactory: () => fileBuffer.length,
                dataItemOpts: {
                    tags: [
                        { name: 'App-Name', value: 'PermRepo' },
                        { name: 'Repo', value: repoName },
                        { name: 'File-Path', value: file.path },
                        { name: 'Content-Type', value: getContentType(file.path) },
                        { name: 'Content-SHA256', value: file.hash },
                        { name: 'Unix-Time', value: String(Math.floor(Date.now() / 1000)) }
                    ]
                }
            });
            const uploadElapsed = Date.now() - startUpload;
            
            uploadResults.push({ path: file.path, txId: result.id, size: fileBuffer.length, hash: file.hash });
            logSuccess(`TX ID: ${result.id} (${uploadElapsed}ms)`);
        }
        
        // 3. MANIFESTA SAGATAVOŠANA
        logSection('📄 MANIFESTA SAGATAVOŠANA');
        
        const history = [...(previousHistory || [])];
        
        if (previousManifestId) {
            history.push({
                backupNumber: previousBackupNumber || history.length,
                manifestId: previousManifestId,
                url: `${ARWEAVE_GATEWAY}/raw/${previousManifestId}`
            });
            logInfo('Vēstures ieraksti', history.length);
        }
        
        const backupCount = Number(await nftContract.getBackupCount(onChainTokenId));
        const newBackupNumber = backupCount + 1;
        logInfo('Jaunais backup numurs', newBackupNumber);
        
        const manifest = {
            metadata: {
                repo: repoName,
                backupNumber: newBackupNumber,
                timestamp: new Date().toISOString(),
                generatedBy: 'PermRepo v1.0.0'
            },
            manifest: 'arweave/paths',
            version: '0.2.0',
            index: { path: 'README.md' },
            paths: {},
            history
        };
        
        for (const file of uploadResults) {
            manifest.paths[file.path] = {
                id: file.txId,
                hash: file.hash,
                url: `${ARWEAVE_GATEWAY}/raw/${file.txId}`
            };
        }
        
        for (const [filePath, info] of Object.entries(unchangedFiles || {})) {
            if (info && info.txId) {
                manifest.paths[filePath] = {
                    id: info.txId,
                    hash: info.hash,
                    url: `${ARWEAVE_GATEWAY}/raw/${info.txId}`
                };
            }
        }
        
        const manifestPaths = Object.keys(manifest.paths);
        if (manifestPaths.length > 0) {
            manifest.index = { path: manifest.paths['README.md'] ? 'README.md' : manifestPaths[0] };
        }
        
        const manifestBuffer = Buffer.from(JSON.stringify(manifest), 'utf8');
        const manifestSize = manifestBuffer.length;
        logInfo('Manifesta izmērs', manifestSize + ' bytes');
        
        const { totalWinc: manifestWinc } = await getWincForBytes(turbo, [manifestSize]);
        const manifestCostEth = await getEthForBytes(turbo, manifestSize);
        
        logInfo('Manifesta Winc', manifestWinc.toString());
        logInfo('Manifesta ETH', manifestCostEth + ' ETH');
        logInfo('Manifesta bezmaksas', manifestWinc === 0n ? '✅ JĀ' : '❌ NĒ');
        
        return res.json({
            success: true,
            step: 'files_uploaded',
            manifestReady: true,
            manifestSize,
            manifestWinc: manifestWinc.toString(),
            manifestCostEth,
            fileCostEth,
            uploadedFiles: uploadResults,
            manifest: manifest
        });
        
    } catch (error) {
        logSection('❌ BACKUP EXECUTE ERROR');
        logError(errorMessage(error));
        console.error(error);
        return res.status(500).json({ success: false, error: errorMessage(error) });
    }
});

// ============================================================
// FINALIZE BACKUP
// ============================================================

app.post('/api/finalize-backup', async (req, res) => {
    try {
        const { repoName, manifest, manifestCostEth, walletAddress } = req.body;
        
        logSection('📄 FINALIZE BACKUP');
        logInfo('Repo', repoName);
        logInfo('Manifesta izmaksas', manifestCostEth + ' ETH');
        
        if (!repoName) return res.status(400).json({ success: false, error: 'Nav repoName' });
        if (!manifest) return res.status(400).json({ success: false, error: 'Nav manifest' });
        if (!manifestCostEth) return res.status(400).json({ success: false, error: 'Nav manifestCostEth' });
        if (!walletAddress) return res.status(400).json({ success: false, error: 'Nav walletAddress' });
        
        const provider = getProvider();
        const turbo = getTurbo();
        
        // 1. MANIFESTA APMAKSA
        const manifestCostWei = ethers.parseEther(manifestCostEth);
        
        logSection('💳 MANIFESTA APMAKSA');
        if (manifestCostWei > 0n) {
            logInfo('Summa', manifestCostEth + ' ETH');
            
            const operatorWallet = getOperatorWallet(provider);
            const treasuryWrite = new ethers.Contract(TREASURY_ADDRESS, TREASURY_ABI, operatorWallet);
            const manifestPaymentId = ethers.id(repoName + '-manifest-' + Date.now().toString());
            const manifestPayTx = await treasuryWrite.payTurbo(manifestCostWei, manifestPaymentId);
            await manifestPayTx.wait();
            
            logSuccess('Transakcija: ' + manifestPayTx.hash);
            logInfo('Payment ID', manifestPaymentId);
            
            await new Promise(resolve => setTimeout(resolve, 5000));
            logSuccess('Gaidīšana pabeigta (5s)');
        } else {
            logSuccess('Manifests ir bezmaksas!');
        }
        
        // 2. MANIFESTA AUGŠUPIELĀDE
        logSection('📤 MANIFESTA AUGŠUPIELĀDE');
        const manifestBuffer = Buffer.from(JSON.stringify(manifest), 'utf8');
        logInfo('Izmērs', manifestBuffer.length + ' bytes');
        
        const startUpload = Date.now();
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
        const uploadElapsed = Date.now() - startUpload;
        
        logSuccess(`TX ID: ${manifestResult.id} (${uploadElapsed}ms)`);
        
        logSection('✅ BACKUPS VEIKSMĪGS');
        logInfo('Manifests', 'ar://' + manifestResult.id);
        logInfo('Manifesta izmaksas', manifestCostEth + ' ETH');
        
        return res.json({
            success: true,
            manifestTxId: manifestResult.id,
            manifestCostEth
        });
        
    } catch (error) {
        logSection('❌ FINALIZE BACKUP ERROR');
        logError(errorMessage(error));
        console.error(error);
        return res.status(500).json({ success: false, error: errorMessage(error) });
    }
});

// ============================================================
// CONTENT TYPE
// ============================================================

function getContentType(filePath) {
    const lower = filePath.toLowerCase();
    if (lower.endsWith('.json')) return 'application/json';
    if (lower.endsWith('.html')) return 'text/html';
    if (lower.endsWith('.css')) return 'text/css';
    if (lower.endsWith('.js') || lower.endsWith('.mjs')) return 'application/javascript';
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

// ============================================================
// GET REPOSITORY FILES
// ============================================================

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

// ============================================================
// HEALTH
// ============================================================

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

// ============================================================
// FRONTEND FALLBACK
// ============================================================

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'backup.html'));
});

// ============================================================
// START
// ============================================================

app.listen(PORT, () => {
    logSection('🚀 PERMAREPO SERVERIS');
    logInfo('Ports', PORT);
    logInfo('RPC_URL', RPC_URL ? '✅ IR' : '❌ NAV');
    logInfo('OPERATOR_PRIVATE_KEY', OPERATOR_PRIVATE_KEY ? '✅ IR' : '❌ NAV');
    logInfo('TREASURY_ADDRESS', TREASURY_ADDRESS || '❌ NAV');
    logInfo('NFT_ADDRESS', NFT_ADDRESS || '❌ NAV');
    logInfo('SUBSCRIPTION_ADDRESS', SUBSCRIPTION_ADDRESS || '❌ NAV');
    logInfo('REGISTRY_ADDRESS', REGISTRY_ADDRESS || '❌ NAV');
    logInfo('TURBO_TOKEN', TURBO_TOKEN);
    logInfo('TURBO_UPLOAD_URL', TURBO_UPLOAD_URL);
    logInfo('TURBO_PAYMENT_URL', TURBO_PAYMENT_URL);
    console.log('='.repeat(60) + '\n');
});
