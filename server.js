import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import { TurboFactory, EthereumSigner } from '@ardrive/turbo-sdk';

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

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// VESELĪBAS PĀRBAUDE
// ==========================================
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        configured: {
            rpc: !!RPC_URL,
            operatorKey: !!OPERATOR_PRIVATE_KEY,
            treasury: !!TREASURY_ADDRESS,
            nft: !!NFT_ADDRESS,
            subscription: !!SUBSCRIPTION_ADDRESS,
            turboUpload: !!TURBO_UPLOAD_URL,
            turboPayment: !!TURBO_PAYMENT_URL
        }
    });
});

// ==========================================
// APRĒĶINĀT IZMAKSAS
// ==========================================
app.post('/api/calculate-cost', async (req, res) => {
    try {
        const { totalBytes } = req.body;
        
        if (!totalBytes || totalBytes <= 0) {
            return res.status(400).json({ error: 'Nav norādīts izmērs' });
        }
        
        if (!OPERATOR_PRIVATE_KEY) {
            return res.status(500).json({ error: 'OPERATOR_PRIVATE_KEY nav konfigurēta' });
        }
        
        const signer = new EthereumSigner(OPERATOR_PRIVATE_KEY);
        const turbo = TurboFactory.authenticated({
            signer,
            token: 'base-eth',
            uploadServiceConfig: { url: TURBO_UPLOAD_URL },
            paymentServiceConfig: { url: TURBO_PAYMENT_URL }
        });
        
        const costs = await turbo.getUploadCosts({ bytes: totalBytes });
        const costInfo = costs[0];
        
        res.json({
            success: true,
            costWei: costInfo.tokenAmount.toString(),
            costEth: ethers.formatEther(costInfo.tokenAmount.toString()),
            winc: costInfo.winc.toString()
        });
        
    } catch (e) {
        console.error('Izmaksu aprēķina kļūda:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// IEGŪT TREASURY BILANCI
// ==========================================
app.get('/api/treasury-balance', async (req, res) => {
    try {
        if (!RPC_URL || !TREASURY_ADDRESS) {
            return res.status(500).json({ error: 'Serveris nav konfigurēts' });
        }
        
        const provider = new ethers.JsonRpcProvider(RPC_URL);
        const treasuryContract = new ethers.Contract(TREASURY_ADDRESS, TREASURY_ABI, provider);
        const balance = await treasuryContract.balance();
        
        res.json({
            success: true,
            balanceWei: balance.toString(),
            balanceEth: ethers.formatEther(balance)
        });
        
    } catch (e) {
        console.error('Treasury bilances kļūda:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// VERIFICĒT PARAKSTU UN IZPILDĪT BACKUPU
// ==========================================
app.post('/api/execute-backup', async (req, res) => {
    try {
        const { repoName, files, signature, message, timestamp, address } = req.body;
        
        if (!repoName) {
            return res.status(400).json({ error: 'Nav repo nosaukuma' });
        }
        
        if (!files || !files.length) {
            return res.status(400).json({ error: 'Nav failu' });
        }
        
        if (!signature || !message || !timestamp || !address) {
            return res.status(400).json({ error: 'Nav paraksta datu' });
        }
        
        if (!OPERATOR_PRIVATE_KEY || !TREASURY_ADDRESS || !RPC_URL) {
            return res.status(500).json({ error: 'Serveris nav pareizi konfigurēts' });
        }
        
        // 0. VERIFICĒT PARAKSTU
        console.log('0. Verificējam parakstu...');
        const now = Math.floor(Date.now() / 1000);
        if (now - timestamp > 600) {
            return res.status(400).json({ error: 'Paraksts novecojis' });
        }
        
        const recoveredAddress = ethers.verifyMessage(message, signature);
        if (recoveredAddress.toLowerCase() !== address.toLowerCase()) {
            return res.status(400).json({ error: 'Paraksts neatbilst adresei' });
        }
        console.log('✅ Paraksts verificēts');
        
        // 1. PĀRBAUDĪT NFT
        console.log('1. Pārbaudam NFT...');
        const provider = new ethers.JsonRpcProvider(RPC_URL);
        
        const repoHash = ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(['string'], [repoName])
        );
        
        const nftContract = new ethers.Contract(NFT_ADDRESS, NFT_ABI, provider);
        const tokenId = await nftContract.repositoryTokens(repoHash);
        
        if (tokenId === 0n) {
            return res.status(400).json({ error: 'Nav NFT šim repo' });
        }
        
        const nftOwner = await nftContract.ownerOf(tokenId);
        if (nftOwner.toLowerCase() !== address.toLowerCase()) {
            return res.status(400).json({ error: 'NFT nepieder šai adresei' });
        }
        console.log('✅ NFT atrasts:', tokenId.toString());
        
        // 2. PĀRBAUDĪT ABONEMENTU
        console.log('2. Pārbaudam abonementu...');
        const subscriptionContract = new ethers.Contract(SUBSCRIPTION_ADDRESS, SUBSCRIPTION_ABI, provider);
        const subscribed = await subscriptionContract.isSubscribed(tokenId);
        
        if (!subscribed) {
            return res.status(400).json({ error: 'Nav abonementa' });
        }
        console.log('✅ Abonements aktīvs');
        
        // 3. APRĒĶINĀT IZMAKSAS
        console.log('3. Aprēķinam izmaksas...');
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
        console.log(`   Izmaksas: ${ethers.formatEther(costWei)} ETH`);
        
        // 4. PĀRBAUDĪT TREASURY BILANCI
        console.log('4. Pārbaudam Treasury bilanci...');
        const operatorWallet = new ethers.Wallet(OPERATOR_PRIVATE_KEY, provider);
        const treasuryContract = new ethers.Contract(TREASURY_ADDRESS, TREASURY_ABI, provider);
        const treasuryBalance = await treasuryContract.balance();
        console.log(`   Treasury: ${ethers.formatEther(treasuryBalance)} ETH`);
        
        if (treasuryBalance < costWei) {
            return res.status(400).json({ 
                error: `Treasury nav pietiekami. Vajag ${ethers.formatEther(costWei)} ETH` 
            });
        }
        
        // 5. IZSAUKT payTurbo()
        console.log('5. Izpilda payTurbo()...');
        const paymentId = ethers.id(repoName + Date.now().toString());
        
        const treasuryWriteContract = new ethers.Contract(TREASURY_ADDRESS, TREASURY_ABI, operatorWallet);
        const payTx = await treasuryWriteContract.payTurbo(costWei, paymentId);
        await payTx.wait();
        console.log('✅ payTurbo() veiksmīgs');
        
        // 6. PIRKT KREDĪTUS
        console.log('6. Pērk kredītus...');
        await turbo.topUpWithTokens({
            tokenAmount: costInfo.tokenAmount.toString()
        });
        console.log('✅ Kredīti nopirkti');
        
        // 7. AUGŠUPIELĀDĒT FAILUS
        console.log('7. Augšupielādē failus...');
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
            
            uploadResults.push({ path: file.path, txId: result.id, size: file.size });
            console.log(`   ✅ ${file.path}: ${result.id}`);
        }
        
        // 8. IZVEIDOT MANIFESTU
        console.log('8. Veido manifestu...');
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
        
        const manifestTxId = manifestResult.id;
        console.log(`✅ Manifests: ar://${manifestTxId}`);
        
        res.json({
            success: true,
            manifestTxId,
            uploadedFiles: uploadResults,
            totalSize: totalBytes,
            costEth: ethers.formatEther(costWei),
            tokenId: tokenId.toString()
        });
        
    } catch (e) {
        console.error('💥 Backup kļūda:', e.message);
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// Statiskie faili
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'storage-pay.html'));
});

app.listen(PORT, () => {
    console.log(`PermRepo serveris klausās uz porta ${PORT}`);
    console.log('Konfigurācija:');
    console.log('  RPC_URL:', RPC_URL || 'NAV');
    console.log('  OPERATOR_PRIVATE_KEY:', OPERATOR_PRIVATE_KEY ? 'IR' : 'NAV');
    console.log('  TREASURY_ADDRESS:', TREASURY_ADDRESS || 'NAV');
    console.log('  NFT_ADDRESS:', NFT_ADDRESS || 'NAV');
    console.log('  SUBSCRIPTION_ADDRESS:', SUBSCRIPTION_ADDRESS || 'NAV');
});
