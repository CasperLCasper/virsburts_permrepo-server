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
import { Redis } from '@upstash/redis';
import JSZip from 'jszip';

import { checkAllServices } from './healthChecks.js';
import { submitBackupWithMerkle } from './merkle.js';

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
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// ============================================================
// HEALTH CHECKS TOGGLE | VESELĪBAS PĀRBAUŽU SLĒDZIS
// ============================================================

const HEALTH_CHECKS_ENABLED = process.env.HEALTH_CHECKS_ENABLED === 'true';

// ============================================================
// REDIS | REDIS
// ============================================================

const redis = (UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN)
    ? new Redis({
        url: UPSTASH_REDIS_REST_URL,
        token: UPSTASH_REDIS_REST_TOKEN,
    })
    : null;

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
// REDIS HELPERS | REDIS PALĪGFUNKCIJAS
// ============================================================

async function getUserCredits(walletAddress) {
    if (!redis) return 0n;
    
    try {
        const credits = await redis.get(`user:${walletAddress.toLowerCase()}:winc`);
        return BigInt(String(credits || '0'));
    } catch (e) {
        logWarning('Redis get kļūda | Redis get error: ' + errorMessage(e));
        return 0n;
    }
}

async function setUserCredits(walletAddress, wincAmount) {
    if (!redis) return;
    
    try {
        await redis.set(`user:${walletAddress.toLowerCase()}:winc`, wincAmount.toString());
        logInfo('Lietotāja kredīti | User credits', `${wincAmount} winc`);
    } catch (e) {
        logWarning('Redis set kļūda | Redis set error: ' + errorMessage(e));
    }
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
        turboToken: TURBO_TOKEN
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
                redis,
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
        
        // ============================================================
        // IEPRIEKŠĒJO MANIFESTU IEGŪŠANA | GET PREVIOUS MANIFESTS
        // ============================================================
        
        let previousPaths = {};
        let previousHistory = [];
        let previousManifestId = null;
        let previousBackupNumber = null;
        
        if (backupCount > 0) {
            logSection('📜 IEPRIEKŠĒJO MANIFESTU IEGŪŠANA | GET PREVIOUS MANIFESTS');
            const manifestURI = await nftContract.getManifestURI(tokenId);
            logInfo('URI', manifestURI);
            
            if (manifestURI && manifestURI.startsWith('ar://')) {
                previousManifestId = manifestURI.slice(5);
                logInfo('Pēdējais manifests | Last manifest', previousManifestId);
                
                try {
                    // 1. Iegūstam pēdējo manifestu
                    const startTime = Date.now();
                    const manifestResponse = await fetch(`${ARWEAVE_GATEWAY}/raw/${previousManifestId}`);
                    const elapsed = Date.now() - startTime;
                    
                    if (manifestResponse.ok) {
                        const previousManifest = await manifestResponse.json();
                        
                        // 2. Apkopojam visus failus no pēdējā manifesta
                        if (previousManifest.paths) {
                            for (const [filePath, info] of Object.entries(previousManifest.paths)) {
                                previousPaths[filePath] = info;
                            }
                        }
                        
                        // 3. Iegūstam history no pēdējā manifesta
                        if (previousManifest.history) {
                            previousHistory = previousManifest.history;
                        }
                        
                        // 4. Iegūstam backup numuru
                        if (previousManifest.metadata && previousManifest.metadata.backupNumber) {
                            previousBackupNumber = previousManifest.metadata.backupNumber;
                        }
                        
                        logInfo('Faili no pēdējā manifesta | Files from last manifest', Object.keys(previousPaths).length);
                        logInfo('Vēstures ieraksti | History entries', previousHistory.length);
                        logInfo('Lejupielādes laiks | Download time', elapsed + 'ms');
                        logSuccess('Pēdējais manifests iegūts | Last manifest obtained');
                    }
                } catch (e) {
                    logWarning('Neizdevās iegūt
