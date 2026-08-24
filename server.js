// server.js

// ============================================================
// IMPORTS | IMPORTI
// ============================================================

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import crypto from 'crypto';
import session from 'express-session';
import { Readable } from 'stream';
import { TurboFactory, EthereumSigner } from '@ardrive/turbo-sdk';
import JSZip from 'jszip';

import { checkAllServices } from './healthChecks.js';
import { submitBackupWithMerkle } from './merkle.js';
import { initRedis, getUserCredits, setUserCredits, getUserDeposits, setUserDeposits, getRedis } from './accounting-redis.js';

// ============================================================
// PATHS | CEĻI
// ============================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// EXPRESS | EKSPRESIS
// ============================================================

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// ENVIRONMENT | VIDES MAINĪGIE
// ============================================================

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
// HEALTH CHECKS TOGGLE | VESELĪBAS PĀRBAUŽU SLĒDZIS
// ============================================================

const HEALTH_CHECKS_ENABLED = process.env.HEALTH_CHECKS_ENABLED === 'true';

// ============================================================
// REDIS INICIALIZĀCIJA | REDIS INITIALIZATION
// ============================================================

initRedis();

// ============================================================
// LOGGING HELPERS | LOGĒŠANAS PALĪGFUNKCIJAS
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
// ABIs | ABI
// ============================================================

const NFT_ABI = [
    "function repositoryTokens(bytes32 repoHash) external view returns (uint256)",
    "function ownerOf(uint256 tokenId) external view returns (address)",
    "function getBackupCount(uint256 tokenId) external view returns (uint256)",
    "function getManifestURI(uint256 tokenId) external view returns (string)",
    "function getNonce(uint256 tokenId) external view returns (uint256)",
    "function addBackup(uint256 tokenId, bytes32 manifestHash, bytes32 merkleRoot, string calldata manifestURI, uint256 deadline, bytes calldata signature) external"
];

const SUBSCRIPTION_ABI = [
    "function isSubscribed(uint256 tokenId) external view returns (bool)"
];

const REGISTRY_ABI = [
    "function getRepositoryByNFT(uint256 nftTokenId) external view returns (bytes32)"
];

const TREASURY_ABI = [
    "function payTurbo(uint256 amount, bytes32 paymentId, address payable destination) external",
    "function balance() external view returns (uint256)"
];

// ============================================================
// EXPRESS MIDDLEWARE | STARPPROGRAMMATŪRA
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
// PROVIDER | NODROŠINĀTĀJS
// ============================================================

function getProvider() {
    if (!RPC_URL) throw new Error('RPC_URL nav konfigurēts | RPC_URL is not configured');
    return new ethers.JsonRpcProvider(RPC_URL);
}

// ============================================================
// OPERATOR WALLET | OPERATORA MAKS
// ============================================================

function getOperatorWallet(provider) {
    if (!OPERATOR_PRIVATE_KEY) throw new Error('OPERATOR_PRIVATE_KEY nav konfigurēts | OPERATOR_PRIVATE_KEY is not configured');
    return new ethers.Wallet(OPERATOR_PRIVATE_KEY, provider);
}

// ============================================================
// TURBO CLIENT | TURBO KLIENTS
// ============================================================

function getTurbo() {
    if (!OPERATOR_PRIVATE_KEY) throw new Error('OPERATOR_PRIVATE_KEY nav konfigurēts | OPERATOR_PRIVATE_KEY is not configured');
    return TurboFactory.authenticated({
        signer: new EthereumSigner(OPERATOR_PRIVATE_KEY),
        token: TURBO_TOKEN,
        gatewayUrl: 'https://sepolia.base.org',
        uploadServiceConfig: { url: TURBO_UPLOAD_URL },
        paymentServiceConfig: { url: TURBO_PAYMENT_URL }
    });
}

// ============================================================
// ERROR HELPER | KĻŪDU PALĪGFUNKCIJA
// ============================================================

function errorMessage(error) {
    return error && typeof error.message === 'string' ? error.message : String(error);
}

// ============================================================
// REPOSITORY HASH | REPOZITORIJA HASH
// ============================================================

function getRepositoryHash(repoName) {
    return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['string'], [repoName]));
}

// ============================================================
// TURBO IZMAKSU APRĒĶINS | TURBO COST CALCULATION
// ============================================================

async function getWincForBytes(turbo, byteSizes) {
    if (!Array.isArray(byteSizes) || byteSizes.length === 0) {
        return { totalWinc: 0n, perFileWinc: [] };
    }
    
    logSection('⚡ TURBO getUploadCosts');
    logInfo('Failu izmēri | File sizes', byteSizes.join(', ') + ' bytes');
    
    const costs = await turbo.getUploadCosts({ bytes: byteSizes });
    
    let totalWinc = 0n;
    const perFileWinc = [];
    
    for (let i = 0; i < costs.length; i++) {
        const winc = BigInt(String(costs[i]?.winc || '0'));
        perFileWinc.push(winc);
        totalWinc += winc;
        logInfo(`Fails #${i + 1} | File #${i + 1}`, `${byteSizes[i]} bytes → ${winc} winc`);
    }
    
    logInfo('Kopējais Winc | Total Winc', totalWinc.toString());
    logInfo('Bezmaksas | Free', totalWinc === 0n ? '✅ JĀ | YES' : '❌ NĒ | NO');
    
    return { totalWinc, perFileWinc };
}

async function getEthForBytes(turbo, totalBytes) {
    if (totalBytes <= 0) {
        return '0';
    }
    
    logSection('💰 TURBO IZMAKSU APRĒĶINS | TURBO COST CALCULATION');
    logInfo('Izmērs | Size', totalBytes + ' bytes');
    
    try {
        const { totalWinc } = await getWincForBytes(turbo, [totalBytes]);
        if (totalWinc === 0n) {
            logSuccess('Bezmaksas augšupielāde! | Free upload!');
            return '0';
        }
    } catch (e) {
        logWarning('getUploadCosts kļūda | error: ' + errorMessage(e));
    }
    
    const { tokenPrice } = await turbo.getTokenPriceForBytes({ byteCount: totalBytes });
    const costEth = String(tokenPrice);
    
    logInfo('ETH cena | ETH price', costEth + ' ETH');
    logInfo('Wei cena | Wei price', ethers.parseEther(costEth).toString() + ' wei');
    
    return costEth;
}

// ============================================================
// TURBO PAYMENT ADDRESS | TURBO MAKSĀJUMA ADRESE
// ============================================================

async function getTurboPaymentAddress() {
    try {
        logInfo('Payment API', TURBO_PAYMENT_URL + '/v1/info');
        
        const response = await fetch(`${TURBO_PAYMENT_URL}/v1/info`);
        
        if (!response.ok) {
            throw new Error(`Payment API HTTP ${response.status}`);
        }
        
        const info = await response.json();
        
        if (!info.addresses) {
            throw new Error('Payment API neatgrieza addresses | Payment API did not return addresses');
        }
        
        const addressMap = {
            'base-eth': info.addresses['base-eth'] || info.addresses['ethereum'],
            'ethereum': info.addresses['ethereum'],
            'base-usdc': info.addresses['base-usdc'] || info.addresses['usdc'],
            'usdc': info.addresses['usdc']
        };
        
        const turboAddress = addressMap[TURBO_TOKEN] || info.addresses['ethereum'];
        
        if (!turboAddress) {
            throw new Error('Nevar atrast adresi tokenam | Cannot find address for token: ' + TURBO_TOKEN);
        }
        
        logSuccess('Turbo payment adrese | Turbo payment address: ' + turboAddress);
        return turboAddress;
        
    } catch (error) {
        logError('Neizdevās iegūt Turbo adresi | Failed to get Turbo address: ' + errorMessage(error));
        throw error;
    }
}

// ============================================================
// CONFIG | KONFIGURĀCIJA
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
        turboToken: TURBO_TOKEN,
        usdcAddress: process.env.USDC_ADDRESS
    });
});

// ============================================================
// GITHUB OAUTH
// ============================================================

app.get('/api/github/login', (req, res) => {
    if (!GITHUB_CLIENT_ID) return res.status(500).json({ success: false, error: 'GitHub OAuth nav konfigurēts | GitHub OAuth is not configured' });
    if (!GITHUB_REDIRECT_URI) return res.status(500).json({ success: false, error: 'GITHUB_REDIRECT_URI nav konfigurēts | GITHUB_REDIRECT_URI is not configured' });
    const scope = 'repo read:org';
    const params = new URLSearchParams({ client_id: GITHUB_CLIENT_ID, scope, redirect_uri: GITHUB_REDIRECT_URI });
    res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
});

app.get('/api/github/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.redirect('/backup.html?error=no_code');
    
    try {
        logSection('🔐 GITHUB OAUTH');
        logInfo('Code', code ? 'saņemts | received' : 'nav | missing');
        
        const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code, redirect_uri: GITHUB_REDIRECT_URI })
        });
        
        if (!tokenResponse.ok) throw new Error(`GitHub OAuth token HTTP ${tokenResponse.status}`);
        const tokenData = await tokenResponse.json();
        
        if (!tokenData.access_token) {
            logError('Netika saņemts access_token | Access token not received');
            return res.redirect('/backup.html?error=token');
        }
        
        logSuccess('Access token saņemts | Access token received');
        req.session.githubToken = tokenData.access_token;
        
        const userResponse = await fetch('https://api.github.com/user', {
            headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/vnd.github.v3+json' }
        });
        
        if (!userResponse.ok) throw new Error(`GitHub user API kļūda | error: ${userResponse.status}`);
        const userData = await userResponse.json();
        
        req.session.githubUser = userData.login;
        req.session.githubAvatar = userData.avatar_url;
        
        logSuccess('Lietotājs | User: ' + userData.login);
        res.redirect('/backup.html?auth=success');
    } catch (error) {
        logError('OAuth kļūda | error: ' + errorMessage(error));
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
// GITHUB REPOS | GITHUB REPOZITORIJI
// ============================================================

app.get('/api/github/repos', async (req, res) => {
    const githubToken = req.session.githubToken;
    if (!githubToken) return res.status(401).json({ success: false, error: 'Nav autorizēts caur GitHub | Not authorized via GitHub' });
    
    try {
        const startTime = Date.now();
        const response = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
            headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github.v3+json' }
        });
        const elapsed = Date.now() - startTime;
        
        if (!response.ok) throw new Error(`GitHub API kļūda | error: ${response.status}`);
        const repos = await response.json();
        
        logSection('🌐 GITHUB REPOS');
        logInfo('Statuss | Status', response.status);
        logInfo('Laiks | Time', elapsed + 'ms');
        logInfo('Repo skaits | Repo count', repos.length);
        
        const repoList = repos.map(repo => ({
            name: repo.full_name,
            description: repo.description,
            private: repo.private,
            language: repo.language,
            updatedAt: repo.updated_at
        }));
        
        res.json({ success: true, repos: repoList });
    } catch (error) {
        logError('Repo saraksta kļūda | error: ' + errorMessage(error));
        res.status(500).json({ success: false, error: errorMessage(error) });
    }
});

// ============================================================
// CHECK REPO STATUS | PĀRBAUDĪT REPO STATUSU
// ============================================================

app.post('/api/check-repo-status', async (req, res) => {
    try {
        const { repoName, walletAddress } = req.body;
        
        logSection('🔍 REPO STATUS PĀRBAUDE | REPO STATUS CHECK');
        logInfo('Repo', repoName);
        logInfo('Wallet', walletAddress);
        
        if (!repoName || !walletAddress) {
            logError('Nav repo vai wallet | Missing repo or wallet');
            return res.status(400).json({ success: false, error: 'Nav repo vai wallet | Missing repo or wallet' });
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
            logInfo('NFT īpašnieks | NFT owner', nftOwner);
            
            if (nftOwner.toLowerCase() === walletAddress.toLowerCase()) {
                hasNFT = true;
                logSuccess('NFT īpašnieks apstiprināts | NFT owner confirmed');
            } else {
                logError('NFT īpašnieks NEATBILST | NFT owner DOES NOT MATCH');
            }
        } else {
            logWarning('NFT nav atrasts | NFT not found');
        }
        
        if (hasNFT) {
            const subscriptionContract = new ethers.Contract(SUBSCRIPTION_ADDRESS, SUBSCRIPTION_ABI, provider);
            hasSubscription = await subscriptionContract.isSubscribed(tokenId);
            logInfo('Abonements | Subscription', hasSubscription ? '✅ Aktīvs | Active' : '❌ Nav aktīvs | Not active');
            
            backupCount = Number(await nftContract.getBackupCount(tokenId));
            logInfo('Backup count', backupCount);
            
            lastManifestURI = await nftContract.getManifestURI(tokenId);
            logInfo('Pēdējais manifests | Last manifest', lastManifestURI);
            
            const registryContract = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, provider);
            try {
                const repoId = await registryContract.getRepositoryByNFT(tokenId);
                isRegistered = repoId !== ethers.ZeroHash;
                logInfo('Reģistrācija | Registration', isRegistered ? '✅ Reģistrēts | Registered' : '❌ Nav reģistrēts | Not registered');
            } catch (e) {
                logWarning('Registry pārbaudes kļūda | error: ' + errorMessage(e));
            }
        }
        
        res.json({ success: true, hasNFT, hasSubscription, isRegistered, tokenId: hasNFT ? tokenId.toString() : '0', backupCount, lastManifestURI });
    } catch (error) {
        logError('Statusa kļūda | error: ' + errorMessage(error));
        res.status(500).json({ success: false, error: errorMessage(error) });
    }
});

// ============================================================
// PREPARE BACKUP | SAGATAVOT BACKUPU
// ============================================================

app.post('/api/prepare-backup', async (req, res) => {
    try {
        const { repoName, walletAddress } = req.body;
        const githubToken = req.session.githubToken;
        
        logSection('📥 PREPARE BACKUP | SAGATAVOT BACKUPU');
        logInfo('Repo', repoName);
        logInfo('Wallet', walletAddress);
        
        // ============================================================
        // VESELĪBAS PĀRBAUDES (PIRMS JEBKĀDA DARBA) | HEALTH CHECKS (BEFORE ANY WORK)
        // ============================================================
        
        if (HEALTH_CHECKS_ENABLED) {
            logSection('🩺 KRITISKO SERVISU KOMBINĒTĀ PĀRBAUDE');
            
            const healthParams = {
                redis: getRedis(),
                rpcUrl: RPC_URL,
                operatorPrivateKey: OPERATOR_PRIVATE_KEY,
                treasuryAddress: TREASURY_ADDRESS,
                nftAddress: NFT_ADDRESS,
                subscriptionAddress: SUBSCRIPTION_ADDRESS,
                registryAddress: REGISTRY_ADDRESS
            };
            
            const health = await checkAllServices(healthParams);
            
            if (!health.allHealthy) {
                logError('❌ Servisi nav pieejami! Process tiek BLOĶĒTS!');
                return res.status(503).json({
                    success: false,
                    error: 'Servisi nav pieejami. Lūdzu mēģini vēlreiz vēlāk.',
                    health
                });
            }
            
            logSuccess('✅ Visi servisi ir pieejami!');
        } else {
            logSection('🩺 VESELĪBAS PĀRBAUDES IZSLĒGTAS');
        }
        
        // ============================================================
        // TURPINA DARBU (TIKAI PĒC PĀRBAUDES) | CONTINUE WORK (AFTER CHECK)
        // ============================================================
        
        if (!repoName) return res.status(400).json({ success: false, error: 'Nav repo nosaukuma | Missing repo name' });
        if (!walletAddress) return res.status(400).json({ success: false, error: 'Nav wallet adreses | Missing wallet address' });
        if (!githubToken) return res.status(401).json({ success: false, error: 'Nav GitHub autorizācijas | No GitHub authorization' });
        
        const provider = getProvider();
        const repoHash = getRepositoryHash(repoName);
        const nftContract = new ethers.Contract(NFT_ADDRESS, NFT_ABI, provider);
        const tokenId = await nftContract.repositoryTokens(repoHash);
        
        logSection('🔍 NFT PĀRBAUDE | NFT CHECK');
        if (tokenId === 0n) {
            logError('Nav NFT šim repo | No NFT for this repo');
            return res.status(400).json({ success: false, error: 'Nav NFT šim repo | No NFT for this repo' });
        }
        logInfo('Token ID', tokenId.toString());
        
        const nftOwner = await nftContract.ownerOf(tokenId);
        if (nftOwner.toLowerCase() !== walletAddress.toLowerCase()) {
            logError('NFT nepieder šai adresei | NFT does not belong to this address');
            return res.status(403).json({ success: false, error: 'NFT nepieder šai adresei | NFT does not belong to this address' });
        }
        logSuccess('NFT īpašnieks OK | NFT owner OK');
        
        logSection('📅 ABONEMENTA PĀRBAUDE | SUBSCRIPTION CHECK');
        const subscriptionContract = new ethers.Contract(SUBSCRIPTION_ADDRESS, SUBSCRIPTION_ABI, provider);
        if (!(await subscriptionContract.isSubscribed(tokenId))) {
            logError('Nav aktīva abonementa | No active subscription');
            return res.status(400).json({ success: false, error: 'Nav aktīva abonementa | No active subscription' });
        }
        logSuccess('Abonements aktīvs | Subscription active');
        
        logSection('📋 REGISTRY PĀRBAUDE | REGISTRY CHECK');
        const registryContract = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, provider);
        const repoId = await registryContract.getRepositoryByNFT(tokenId);
        if (repoId === ethers.ZeroHash) {
            logError('Repo nav reģistrēts Registry | Repo not registered in Registry');
            return res.status(400).json({ success: false, error: 'Repo nav reģistrēts Registry | Repo not registered in Registry' });
        }
        logSuccess('Repo reģistrēts | Repo registered');
        
        const backupCount = Number(await nftContract.getBackupCount(tokenId));
        logInfo('Backup count', backupCount);
        
        let previousPaths = {};
        let previousHistory = [];
        let previousManifestId = null;
        let previousBackupNumber = null;
        
        if (backupCount > 0) {
            logSection('📜 IEPRIEKŠĒJAIS MANIFESTS | PREVIOUS MANIFEST');
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
                        
                        logInfo('Faili | Files', Object.keys(previousPaths).length);
                        logInfo('Vēstures ieraksti | History entries', previousHistory.length);
                        logInfo('Lejupielādes laiks | Download time', elapsed + 'ms');
                        logSuccess('Iepriekšējais manifests iegūts | Previous manifest obtained');
                    }
                } catch (e) {
                    logWarning('Neizdevās iegūt iepriekšējo manifestu | Failed to get previous manifest: ' + errorMessage(e));
                }
            }
        }
        
        logSection('🌐 GITHUB FAILI | GITHUB FILES');
        const repoParts = repoName.split('/');
        const startTime = Date.now();
        const currentFiles = await getRepoFiles(githubToken, repoParts[0], repoParts[1]);
        const elapsed = Date.now() - startTime;
        
        if (currentFiles.length === 0) {
            logError('Nav failu repo | No files in repo');
            return res.status(400).json({ success: false, error: 'Nav failu repo | No files in repo' });
        }
        logInfo('Kopā faili | Total files', currentFiles.length);
        logInfo('Laiks | Time', elapsed + 'ms');
        
        const changedFiles = [];
        const unchangedFiles = {};
        
        for (const file of currentFiles) {
            const previousFile = previousPaths[file.path];
            if (previousFile && previousFile.zipId && previousFile.hash && previousFile.hash === file.hash) {
                unchangedFiles[file.path] = { zipId: previousFile.zipId, size: file.size, hash: file.hash };
            } else {
                changedFiles.push(file);
            }
        }
        
        logInfo('Mainīti | Changed', changedFiles.length);
        logInfo('Nemainīti | Unchanged', Object.keys(unchangedFiles).length);
        
        if (changedFiles.length === 0) {
            logSuccess('Nav izmaiņu | No changes');
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
                message: 'Nav izmaiņu | No changes'
            });
        }
        
        for (const file of changedFiles) {
            logInfo(`Mainīts | Changed: ${file.path}`, `${file.size} bytes`);
        }
        
        logSection('⚡ TURBO IZMAKSAS | TURBO COSTS');
        const turbo = getTurbo();
        
        const totalFileBytes = changedFiles.reduce((sum, file) => sum + file.size, 0);
        
        // Aprēķina aptuveno ZIP izmēru
        const estimatedZipSize = Math.ceil(totalFileBytes * 1.1); // 10% rezerve ZIP overhead
        const { totalWinc: fileWinc } = await getWincForBytes(turbo, [estimatedZipSize]);
        
        const userCredits = await getUserCredits(walletAddress);
        logInfo('Lietotāja kredīti | User credits', userCredits.toString() + ' winc');
        
        let fileCostEth;
        let newUserCredits;
        
        if (userCredits >= fileWinc) {
            newUserCredits = userCredits - fileWinc;
            fileCostEth = '0';
            logSuccess('Pietiek kredītu! | Enough credits!');
            logInfo('Atlikums | Remaining', newUserCredits.toString() + ' winc');
        } else {
            const deficitWinc = fileWinc - userCredits;
            logInfo('Deficīts | Deficit', deficitWinc.toString() + ' winc');
            
            fileCostEth = await getEthForBytes(turbo, estimatedZipSize);
            newUserCredits = 0n;
            logInfo('Jāmaksā | Must pay', fileCostEth + ' ETH');
        }
        
        logSection('🏦 TREASURY');
        let treasuryBalance = 0n;
        if (TREASURY_ADDRESS) {
            const treasuryContract = new ethers.Contract(TREASURY_ADDRESS, TREASURY_ABI, provider);
            treasuryBalance = await treasuryContract.balance();
        }
        logInfo('Bilance | Balance', ethers.formatEther(treasuryBalance) + ' ETH');
        
        const fileCostWei = ethers.parseEther(fileCostEth);
        const hasEnoughTreasury = fileCostWei === 0n ? true : treasuryBalance >= fileCostWei;
        logInfo('Nepieciešams | Required', fileCostEth + ' ETH');
        logInfo('Pietiekami | Enough', hasEnoughTreasury ? '✅ JĀ | YES' : '❌ NĒ | NO');
        
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
            estimatedZipSize,
            fileWinc: fileWinc.toString(),
            fileCostEth,
            userCredits: userCredits.toString(),
            newUserCredits: newUserCredits.toString(),
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
// EXECUTE BACKUP | IZPILDĪT BACKUPU
// ============================================================

app.post('/api/execute-backup', async (req, res) => {
    try {
        const { repoName, files, unchangedFiles, tokenId, fileCostEth, walletAddress, previousHistory, previousManifestId, previousBackupNumber, fileWinc, newUserCredits } = req.body;
        
        logSection('📤 EXECUTE BACKUP | IZPILDĪT BACKUPU');
        logInfo('Repo', repoName);
        logInfo('Mainītie faili | Changed files', files.length);
        logInfo('Token ID', tokenId);
        logInfo('Failu izmaksas | File costs', fileCostEth + ' ETH');
        logInfo('Wallet', walletAddress);
        
        if (!repoName) return res.status(400).json({ success: false, error: 'Nav repoName | Missing repoName' });
        if (!walletAddress) return res.status(400).json({ success: false, error: 'Nav walletAddress | Missing walletAddress' });
        if (!Array.isArray(files)) return res.status(400).json({ success: false, error: 'files nav masīvs | files is not array' });
        if (!tokenId) return res.status(400).json({ success: false, error: 'Nav tokenId | Missing tokenId' });
        if (fileCostEth === undefined) return res.status(400).json({ success: false, error: 'Nav fileCostEth | Missing fileCostEth' });
        
        const provider = getProvider();
        const nftContract = new ethers.Contract(NFT_ADDRESS, NFT_ABI, provider);
        const repoHash = getRepositoryHash(repoName);
        const onChainTokenId = await nftContract.repositoryTokens(repoHash);
        
        if (onChainTokenId === 0n) return res.status(400).json({ success: false, error: 'Repo NFT vairs nepastāv | Repo NFT no longer exists' });
        
        const nftOwner = await nftContract.ownerOf(onChainTokenId);
        if (nftOwner.toLowerCase() !== walletAddress.toLowerCase()) return res.status(403).json({ success: false, error: 'NFT nepieder wallet adresei | NFT does not belong to wallet address' });
        
        const subscriptionContract = new ethers.Contract(SUBSCRIPTION_ADDRESS, SUBSCRIPTION_ABI, provider);
        if (!(await subscriptionContract.isSubscribed(onChainTokenId))) return res.status(400).json({ success: false, error: 'Abonements vairs nav aktīvs | Subscription no longer active' });
        
        const registryContract = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, provider);
        const repoId = await registryContract.getRepositoryByNFT(onChainTokenId);
        if (repoId === ethers.ZeroHash) return res.status(400).json({ success: false, error: 'Repo nav reģistrēts Registry | Repo not registered in Registry' });
        
        const turbo = getTurbo();
        
        // ============================================================
        // 1. ZIP ARHĪVA IZVEIDE | CREATE ZIP ARCHIVE
        // ============================================================
        
        logSection('📦 ZIP ARHĪVA IZVEIDE | CREATE ZIP ARCHIVE');
        const zip = new JSZip();
        
        for (const file of files) {
            const fileBuffer = Buffer.from(file.content, 'base64');
            zip.file(file.path, fileBuffer);
            logInfo(`Pievienots | Added: ${file.path}`, fileBuffer.length + ' bytes');
        }
        
        const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
        logInfo('ZIP izmērs | ZIP size', zipBuffer.length + ' bytes');
        
        // ============================================================
        // 2. ZIP APMAKSA | ZIP PAYMENT
        // ============================================================
        
        const fileCostWei = ethers.parseEther(fileCostEth);
        
        logSection('💳 ZIP APMAKSA | ZIP PAYMENT');
        if (fileCostWei > 0n) {
            logInfo('Summa | Amount', fileCostEth + ' ETH');
            logInfo('Wei | Wei', fileCostWei.toString());
            
            const turboAddress = await getTurboPaymentAddress();
            logInfo('Turbo adrese | Turbo address', turboAddress);
            
            const operatorWallet = getOperatorWallet(provider);
            logInfo('Operatora adrese | Operator address', operatorWallet.address);
            
            const treasuryWrite = new ethers.Contract(TREASURY_ADDRESS, TREASURY_ABI, operatorWallet);
            const filePaymentId = ethers.id(repoName + '-zip-' + Date.now().toString());
            const filePayTx = await treasuryWrite.payTurbo(fileCostWei, filePaymentId, turboAddress);
            await filePayTx.wait();
            
            logSuccess('Transakcija | Transaction: ' + filePayTx.hash);
            logInfo('Payment ID', filePaymentId);
            logInfo('Destination', turboAddress);
            
            await new Promise(resolve => setTimeout(resolve, 5000));
            logSuccess('Gaidīšana pabeigta | Waiting completed (5s)');
        } else {
            logSuccess('Izmanto lietotāja kredītus! | Using user credits!');
        }
        
        // ============================================================
        // 3. ZIP AUGŠUPIELĀDE | ZIP UPLOAD
        // ============================================================
        
        logSection('📤 ZIP AUGŠUPIELĀDE | ZIP UPLOAD');
        const startUpload = Date.now();
        const zipResult = await turbo.uploadFile({
            fileStreamFactory: () => Readable.from(zipBuffer),
            fileSizeFactory: () => zipBuffer.length,
            dataItemOpts: {
                tags: [
                    { name: 'App-Name', value: 'PermRepo' },
                    { name: 'Repo', value: repoName },
                    { name: 'Type', value: 'backup-archive' },
                    { name: 'Content-Type', value: 'application/zip' },
                    { name: 'Unix-Time', value: String(Math.floor(Date.now() / 1000)) }
                ]
            }
        });
        const uploadElapsed = Date.now() - startUpload;
        
        logSuccess(`ZIP TX ID: ${zipResult.id} (${uploadElapsed}ms)`);
        
        // ============================================================
        // 4. ATJAUNINA LIETOTĀJA KREDĪTUS | UPDATE USER CREDITS
        // ============================================================
        
        logSection('💾 KREDĪTU ATJAUNINĀŠANA | CREDIT UPDATE');
        await setUserCredits(walletAddress, BigInt(newUserCredits || '0'));
        logSuccess('Lietotāja kredīti atjaunināti | User credits updated');
        
        // ============================================================
        // 5. MANIFESTA SAGATAVOŠANA | MANIFEST PREPARATION
        // ============================================================
        
        logSection('📄 MANIFESTA SAGATAVOŠANA | MANIFEST PREPARATION');
        
        const history = [...(previousHistory || [])];
        
        if (previousManifestId) {
            history.push({
                backupNumber: previousBackupNumber || history.length,
                manifestId: previousManifestId,
                url: `${ARWEAVE_GATEWAY}/raw/${previousManifestId}`
            });
        }
        
        history.sort((a, b) => Number(b.backupNumber) - Number(a.backupNumber));
        
        logInfo('Vēstures ieraksti | History entries', history.length);
        
        const backupCount = Number(await nftContract.getBackupCount(onChainTokenId));
        const newBackupNumber = backupCount + 1;
        logInfo('Jaunais backup numurs | New backup number', newBackupNumber);
        
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
            archive: {
                id: zipResult.id,
                url: `${ARWEAVE_GATEWAY}/raw/${zipResult.id}`,
                contains: files.map(file => ({
                    path: file.path,
                    hash: file.hash
                }))
            },
            paths: {},
            history
        };
        
        // Pievieno mainītos failus no jaunā ZIP
        for (const file of files) {
            manifest.paths[file.path] = {
                zipId: zipResult.id,
                hash: file.hash
            };
        }
        
        // Pievieno nemainītos failus ar veco zipId
        for (const [filePath, info] of Object.entries(unchangedFiles || {})) {
            if (info && info.zipId) {
                manifest.paths[filePath] = {
                    zipId: info.zipId,
                    hash: info.hash
                };
            }
        }
        
        const manifestPaths = Object.keys(manifest.paths);
        if (manifestPaths.length > 0) {
            manifest.index = { path: manifest.paths['README.md'] ? 'README.md' : manifestPaths[0] };
        }
        
        const manifestBuffer = Buffer.from(JSON.stringify(manifest), 'utf8');
        const manifestSize = manifestBuffer.length;
        logInfo('Manifesta izmērs | Manifest size', manifestSize + ' bytes');
        
        const { totalWinc: manifestWinc } = await getWincForBytes(turbo, [manifestSize]);
        
        const currentUserCredits = await getUserCredits(walletAddress);
        let manifestCostEth;
        let newManifestCredits;
        
        if (currentUserCredits >= manifestWinc) {
            newManifestCredits = currentUserCredits - manifestWinc;
            manifestCostEth = '0';
            logSuccess('Manifestam pietiek kredītu! | Enough credits for manifest!');
        } else {
            const manifestDeficit = manifestWinc - currentUserCredits;
            logInfo('Manifesta deficīts | Manifest deficit', manifestDeficit.toString() + ' winc');
            manifestCostEth = await getEthForBytes(turbo, manifestSize);
            newManifestCredits = 0n;
        }
        
        logInfo('Manifesta Winc | Manifest Winc', manifestWinc.toString());
        logInfo('Manifesta ETH | Manifest ETH', manifestCostEth + ' ETH');
        
        return res.json({
            success: true,
            step: 'zip_uploaded',
            manifestReady: true,
            zipTxId: zipResult.id,
            manifestSize,
            manifestWinc: manifestWinc.toString(),
            manifestCostEth,
            fileCostEth,
            uploadedFiles: files.map(file => ({ path: file.path, txId: zipResult.id, size: file.size, hash: file.hash })),
            manifest: manifest,
            newManifestCredits: newManifestCredits.toString()
        });
        
    } catch (error) {
        logSection('❌ BACKUP EXECUTE ERROR');
        logError(errorMessage(error));
        console.error(error);
        return res.status(500).json({ success: false, error: errorMessage(error) });
    }
});

// ============================================================
// FINALIZE BACKUP | PABEIGT BACKUPU
// ============================================================

app.post('/api/finalize-backup', async (req, res) => {
    try {
        const { 
            repoName, 
            manifest, 
            manifestCostEth, 
            walletAddress, 
            newManifestCredits,
            tokenId,
            files
        } = req.body;
        
        logSection('📄 FINALIZE BACKUP | PABEIGT BACKUPU');
        logInfo('Repo', repoName);
        logInfo('Token ID', tokenId);
        logInfo('Faili | Files', files ? files.length : 0);
        logInfo('Manifesta izmaksas | Manifest costs', manifestCostEth + ' ETH');
        logInfo('Wallet', walletAddress);
        
        if (!repoName) return res.status(400).json({ success: false, error: 'Nav repoName | Missing repoName' });
        if (!manifest) return res.status(400).json({ success: false, error: 'Nav manifest | Missing manifest' });
        if (manifestCostEth === undefined) return res.status(400).json({ success: false, error: 'Nav manifestCostEth | Missing manifestCostEth' });
        if (!walletAddress) return res.status(400).json({ success: false, error: 'Nav walletAddress | Missing walletAddress' });
        if (!tokenId) return res.status(400).json({ success: false, error: 'Nav tokenId | Missing tokenId' });
        
        const provider = getProvider();
        const turbo = getTurbo();
        
        // 1. MANIFESTA APMAKSA | MANIFEST PAYMENT
        const manifestCostWei = ethers.parseEther(manifestCostEth);
        
        logSection('💳 MANIFESTA APMAKSA | MANIFEST PAYMENT');
        if (manifestCostWei > 0n) {
            logInfo('Summa | Amount', manifestCostEth + ' ETH');
            logInfo('Wei | Wei', manifestCostWei.toString());
            
            const turboAddress = await getTurboPaymentAddress();
            logInfo('Turbo adrese | Turbo address', turboAddress);
            
            const operatorWallet = getOperatorWallet(provider);
            logInfo('Operatora adrese | Operator address', operatorWallet.address);
            
            const treasuryWrite = new ethers.Contract(TREASURY_ADDRESS, TREASURY_ABI, operatorWallet);
            const manifestPaymentId = ethers.id(repoName + '-manifest-' + Date.now().toString());
            const manifestPayTx = await treasuryWrite.payTurbo(manifestCostWei, manifestPaymentId, turboAddress);
            await manifestPayTx.wait();
            
            logSuccess('Transakcija | Transaction: ' + manifestPayTx.hash);
            logInfo('Payment ID', manifestPaymentId);
            logInfo('Destination', turboAddress);
            
            await new Promise(resolve => setTimeout(resolve, 5000));
            logSuccess('Gaidīšana pabeigta | Waiting completed (5s)');
        } else {
            logSuccess('Manifests izmanto kredītus! | Manifest uses credits!');
        }
        
        // 2. MANIFESTA AUGŠUPIELĀDE | MANIFEST UPLOAD
        logSection('📤 MANIFESTA AUGŠUPIELĀDE | MANIFEST UPLOAD');
        const manifestBuffer = Buffer.from(JSON.stringify(manifest), 'utf8');
        logInfo('Izmērs | Size', manifestBuffer.length + ' bytes');
        
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
        
        // 3. ATJAUNINA LIETOTĀJA KREDĪTUS | UPDATE USER CREDITS
        logSection('💾 KREDĪTU ATJAUNINĀŠANA | CREDIT UPDATE');
        await setUserCredits(walletAddress, BigInt(newManifestCredits || '0'));
        logSuccess('Lietotāja kredīti atjaunināti | User credits updated');
        
        logSection('✅ MANIFESTS AUGŠUPIELĀDĒTS | MANIFEST UPLOADED');
        logInfo('Manifests', 'ar://' + manifestResult.id);
        logInfo('Manifesta izmaksas | Manifest costs', manifestCostEth + ' ETH');
        
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
// FINALIZE BACKUP SIGN | PARAKSTĪT BACKUPU
// ============================================================

app.post('/api/finalize-backup/sign', async (req, res) => {
    try {
        const { tokenId, manifestTxId, files, deadline, signature } = req.body;
        
        if (!tokenId) return res.status(400).json({ success: false, error: 'Nav tokenId | Missing tokenId' });
        if (!manifestTxId) return res.status(400).json({ success: false, error: 'Nav manifestTxId | Missing manifestTxId' });
        if (!signature) return res.status(400).json({ success: false, error: 'Nav signature | Missing signature' });
        
        const provider = getProvider();
        const nftContract = new ethers.Contract(process.env.NFT_ADDRESS, NFT_ABI, provider);
        
        const merkleTxHash = await submitBackupWithMerkle({
            tokenId: tokenId,
            manifestTxId: manifestTxId,
            files: files || [],
            deadline: deadline,
            signature: signature,
            nftContract: new ethers.Contract(process.env.NFT_ADDRESS, NFT_ABI, getOperatorWallet(provider)),
            readContract: nftContract
        });
        
        logSuccess('Merkle sakne iesniegta! | Merkle root submitted!');
        logInfo('Transakcija | Transaction', merkleTxHash);
        
        return res.json({ success: true, merkleTxHash });
        
    } catch (error) {
        logError('Sign kļūda | Sign error: ' + errorMessage(error));
        return res.status(500).json({ success: false, error: errorMessage(error) });
    }
});

// ============================================================
// CONTENT TYPE | SATURA TIPS
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
// GET REPOSITORY FILES | IEGŪT REPOZITORIJA FAILUS
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
    
    if (!response.ok) throw new Error(`GitHub API kļūda | error: ${response.status}`);
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
// HEALTH | VESELĪBA
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
            githubOAuth: !!(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET && GITHUB_REDIRECT_URI),
            redis: !!getRedis()
        }
    });
});

// ============================================================
// FRONTEND FALLBACK | FRONTEND ATKĀPŠANĀS
// ============================================================

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'backup.html'));
});

// ============================================================
// START | SĀKUMS
// ============================================================

app.listen(PORT, () => {
    logSection('🚀 PERMAREPO SERVERIS | PERMAREPO SERVER');
    logInfo('Ports | Port', PORT);
    logInfo('RPC_URL', RPC_URL ? '✅ IR | YES' : '❌ NAV | NO');
    logInfo('OPERATOR_PRIVATE_KEY', OPERATOR_PRIVATE_KEY ? '✅ IR | YES' : '❌ NAV | NO');
    logInfo('TREASURY_ADDRESS', TREASURY_ADDRESS || '❌ NAV | NO');
    logInfo('NFT_ADDRESS', NFT_ADDRESS || '❌ NAV | NO');
    logInfo('SUBSCRIPTION_ADDRESS', SUBSCRIPTION_ADDRESS || '❌ NAV | NO');
    logInfo('REGISTRY_ADDRESS', REGISTRY_ADDRESS || '❌ NAV | NO');
    logInfo('TURBO_TOKEN', TURBO_TOKEN);
    logInfo('TURBO_UPLOAD_URL', TURBO_UPLOAD_URL);
    logInfo('TURBO_PAYMENT_URL', TURBO_PAYMENT_URL);
    logInfo('REDIS', getRedis() ? '✅ IR | YES' : '❌ NAV | NO');
    console.log('='.repeat(60) + '\n');
});
