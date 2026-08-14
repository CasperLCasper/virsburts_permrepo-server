import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import { TurboFactory, EthereumSigner } from '@ardrive/turbo-sdk';
import crypto from 'crypto';

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

const TREASURY_ABI = [
    "function payTurbo(uint256 amount, bytes32 paymentId) external",
    "function balance() external view returns (uint256)"
];

// Pagaidu backupu glabātuve (Render atmiņā)
const pendingBackups = new Map();

app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function checkApiKey(req, res, next) {
    if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
        return res.status(401).json({ error: 'Nederīga API atslēga' });
    }
    next();
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
            apiKey: !!API_KEY
        }
    });
});

// ==========================================
// SAGATAVOT BACKUPU (no GitHub Action)
// ==========================================
app.post('/api/prepare-backup', checkApiKey, async (req, res) => {
    try {
        const { repoName, files, unchangedFiles, deletedFiles, walletAddress } = req.body;
        
        console.log('\n=== BACKUP SAGATAVOŠANA ===');
        console.log('Repo:', repoName);
        console.log('Faili:', files ? files.length : 0);
        console.log('Wallet:', walletAddress);
        
        if (!repoName) return res.status(400).json({ error: 'Nav repo nosaukuma' });
        if (!files || !files.length) return res.status(400).json({ error: 'Nav failu' });
        if (!OPERATOR_PRIVATE_KEY) return res.status(500).json({ error: 'Serveris nav konfigurēts' });
        
        // Aprēķināt izmaksas
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
        
        // Izveidot backup ID
        const backupId = crypto.randomBytes(16).toString('hex');
        
        // Saglabāt pagaidu backupu
        pendingBackups.set(backupId, {
            repoName,
            files,
            unchangedFiles,
            deletedFiles,
            walletAddress,
            costWei: costWei.toString(),
            costEth,
            status: 'pending',
            createdAt: Date.now()
        });
        
        console.log('Backup ID:', backupId);
        console.log('Statuss: gaida apmaksu');
        
        res.json({
            success: true,
            backupId,
            costEth,
            totalBytes,
            status: 'pending'
        });
        
    } catch (e) {
        console.error('Backup sagatavošanas kļūda:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// IEGŪT BACKUP INFORMĀCIJU (apmaksas lapai)
// ==========================================
app.get('/api/backup-info/:backupId', checkApiKey, (req, res) => {
    const { backupId } = req.params;
    const backup = pendingBackups.get(backupId);
    
    if (!backup) {
        return res.status(404).json({ error: 'Backups nav atrasts' });
    }
    
    res.json({
        success: true,
        repoName: backup.repoName,
        costEth: backup.costEth,
        status: backup.status
    });
});

// ==========================================
// APMAKSĀT UN IZPILDĪT BACKUPU
// ==========================================
app.post('/api/execute-backup', checkApiKey, async (req, res) => {
    try {
        const { backupId, paymentTxHash, walletAddress } = req.body;
        
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
        
        // 1. Pārbaudīt, vai apmaksa saņemta Treasury
        console.log('1. Pārbaudam Treasury...');
        const provider = new ethers.JsonRpcProvider(RPC_URL);
        const treasuryContract = new ethers.Contract(TREASURY_ADDRESS, TREASURY_ABI, provider);
        const treasuryBalance = await treasuryContract.balance();
        const requiredWei = BigInt(backup.costWei);
        
        console.log('   Treasury:', ethers.formatEther(treasuryBalance), 'ETH');
        console.log('   Nepieciešams:', ethers.formatEther(requiredWei), 'ETH');
        
        if (treasuryBalance < requiredWei) {
            backup.status = 'pending';
            return res.status(400).json({ 
                error: `Treasury nav pietiekami. Vajag ${ethers.formatEther(requiredWei)} ETH` 
            });
        }
        
        // 2. Operatora maks
        const operatorWallet = new ethers.Wallet(OPERATOR_PRIVATE_KEY, provider);
        console.log('2. Operators:', operatorWallet.address);
        
        // 3. Izsaukt payTurbo()
        console.log('3. Izpilda payTurbo()...');
        const paymentId = ethers.id(backup.repoName + Date.now().toString());
        const treasuryWriteContract = new ethers.Contract(TREASURY_ADDRESS, TREASURY_ABI, operatorWallet);
        const payTx = await treasuryWriteContract.payTurbo(requiredWei, paymentId);
        await payTx.wait();
        console.log('   ✅ payTurbo() veiksmīgs');
        
        // 4. Pērk kredītus
        console.log('4. Pērk kredītus...');
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
        console.log('   ✅ Kredīti nopirkti');
        
        // 5. Augšupielādēt failus
        console.log('5. Augšupielādē failus...');
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
            
            console.log(`   [${i + 1}/${backup.files.length}] ✅ ${file.path}`);
        }
        
        // 6. Izveidot manifestu
        console.log('6. Veido manifestu...');
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
        
        // Pievienot jaunos failus
        for (const f of uploadResults) {
            manifest.paths[f.path] = { id: f.txId };
        }
        
        // Pievienot nemainītos failus
        for (const [fp, info] of Object.entries(backup.unchangedFiles)) {
            manifest.paths[fp] = { id: info.txId };
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
        console.log('   ✅ Manifests:', manifestTxId);
        
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
        console.error('💥 Backup izpildes kļūda:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// IEGŪT BACKUP REZULTĀTU
// ==========================================
app.get('/api/backup-result/:backupId', checkApiKey, (req, res) => {
    const { backupId } = req.params;
    const backup = pendingBackups.get(backupId);
    
    if (!backup) {
        return res.status(404).json({ error: 'Backups nav atrasts' });
    }
    
    res.json({
        success: true,
        backupId,
        status: backup.status,
        manifestTxId: backup.manifestTxId || null,
        uploadResults: backup.uploadResults || [],
        costEth: backup.costEth
    });
});

// Statiskie faili
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'storage-pay.html'));
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
    console.log('  API_KEY:', API_KEY ? 'IR' : 'NAV');
    console.log('========================================');
});
