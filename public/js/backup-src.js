// backup-src.js
// Priekšpuses loģika backupu un atjaunošanai.

const { ethers } = window;

let CONFIG = {};
let userAddress = null;
let currentRepo = null;
let currentTokenId = '0';
let currentUnchangedFiles = {};
let currentFiles = [];
let currentFileCostEth = '0';
let currentManifestCostEth = '0';
let currentManifest = null;
let currentPreviousHistory = [];
let currentPreviousManifestId = null;
let currentPreviousBackupNumber = null;
let currentUploadedFiles = [];
let currentNewManifestCredits = '0';
let hasDepositedFiles = false;
let hasDepositedManifest = false;

// NFT līguma ABI | NFT contract ABI
const NFT_ABI = [
    "function addBackup(uint256 tokenId, bytes32 manifestHash, bytes32 merkleRoot, string calldata manifestURI, uint256 deadline, bytes calldata signature) external",
    "function getNonce(uint256 tokenId) external view returns (uint256)",
    "function getBackupCount(uint256 tokenId) external view returns (uint256)"
];

// Treasury līguma ABI | Treasury contract ABI
const TREASURY_ABI = [
    "function balance() external view returns (uint256)"
];

// ============================================================
// INITIALIZATION | INICIALIZĀCIJA
// ============================================================

async function init() {
    try {
        const configResponse = await fetch('/api/config');
        CONFIG = await configResponse.json();
    } catch (e) {
        console.error('Neizdevās iegūt konfigurāciju:', e.message);
    }
    
    const userResponse = await fetch('/api/github/user');
    const userData = await userResponse.json();
    
    if (userData.success) {
        showUserSection(userData);
        await loadRepos();
    } else {
        showAuthSection();
    }
}

function showAuthSection() {
    document.getElementById('authSection').style.display = 'block';
    document.getElementById('loginButton').onclick = () => {
        window.location.href = '/api/github/login';
    };
}

function showUserSection(userData) {
    document.getElementById('authSection').style.display = 'none';
    document.getElementById('userSection').style.display = 'block';
    document.getElementById('userName').textContent = userData.user;
    document.getElementById('logoutButton').onclick = async () => {
        await fetch('/api/github/logout');
        window.location.reload();
    };
}

async function loadRepos() {
    const response = await fetch('/api/github/repos');
    const data = await response.json();
    
    if (data.success && data.repos.length > 0) {
        const select = document.getElementById('repoSelect');
        select.innerHTML = '';
        
        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = 'Izvēlies repozitoriju...';
        select.appendChild(defaultOption);
        
        for (const repo of data.repos) {
            const option = document.createElement('option');
            option.value = repo.name;
            option.textContent = repo.name + (repo.private ? ' 🔒' : '');
            select.appendChild(option);
        }
        
        document.getElementById('repoSection').style.display = 'block';
        document.getElementById('walletSection').style.display = 'block';
        
        select.onchange = async () => {
            if (select.value && userAddress) {
                await checkRepoStatus(select.value);
            } else if (select.value && !userAddress) {
                setStatus('Vispirms savieno maku!');
            }
        };
    } else {
        showError('Nav repozitoriju');
    }
}

async function connectWallet() {
    if (!window.ethereum) {
        showError('Lūdzu instalē MetaMask!');
        return;
    }
    
    try {
        await window.ethereum.request({ 
            method: 'wallet_switchEthereumChain', 
            params: [{ chainId: CONFIG.chainId }] 
        });
        
        const provider = new ethers.BrowserProvider(window.ethereum);
        const signer = await provider.getSigner();
        userAddress = await signer.getAddress();
        
        document.getElementById('walletInput').value = userAddress;
        setStatus('Maks savienots: ' + userAddress.substring(0, 10) + '...');
        
        const select = document.getElementById('repoSelect');
        if (select.value) {
            await checkRepoStatus(select.value);
        }
    } catch (e) {
        showError(e.message);
    }
}

async function checkRepoStatus(repoName) {
    currentRepo = repoName;
    hasDepositedFiles = false;
    hasDepositedManifest = false;
    
    const statusSection = document.getElementById('statusSection');
    statusSection.style.display = 'block';
    
    document.getElementById('nftStatus').textContent = '⏳ Pārbauda NFT...';
    document.getElementById('subscriptionStatus').textContent = '⏳ Pārbauda abonementu...';
    
    const response = await fetch('/api/check-repo-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoName, walletAddress: userAddress })
    });
    
    const result = await response.json();
    
    if (result.success) {
        currentTokenId = result.tokenId;
        
        if (result.hasNFT) {
            document.getElementById('nftStatus').textContent = '✅ NFT atrasts (Token ID: ' + result.tokenId + ')';
            if (result.backupCount > 0) {
                document.getElementById('nftStatus').textContent += ' | Backupi: ' + result.backupCount;
            }
        } else {
            document.getElementById('nftStatus').innerHTML = 
                '❌ Nav NFT — <a href="/nft.html?repo=' + encodeURIComponent(repoName) + '">Izveidot NFT</a>';
        }
        
        if (result.hasSubscription) {
            document.getElementById('subscriptionStatus').textContent = '✅ Abonements aktīvs';
        } else {
            document.getElementById('subscriptionStatus').innerHTML = 
                '❌ Nav abonementa — <a href="/subscribe.html?repo=' + encodeURIComponent(repoName) + '">Iegādāties</a>';
        }
        
        const backupButton = document.getElementById('backupButton');
        
        if (result.hasNFT && result.hasSubscription && result.isRegistered) {
            backupButton.style.display = 'block';
            backupButton.disabled = false;
            backupButton.textContent = 'Sākt backupu';
            backupButton.onclick = prepareBackup;
        } else {
            backupButton.style.display = 'none';
            if (result.hasNFT && result.hasSubscription && !result.isRegistered) {
                document.getElementById('status').innerHTML = 
                    '❌ Repo nav reģistrēts — <a href="/register.html?repo=' + encodeURIComponent(repoName) + '">Reģistrēt repo</a>';
            }
        }
    } else {
        showError(result.error || 'Kļūda');
    }
}

async function prepareBackup() {
    const button = document.getElementById('backupButton');
    button.disabled = true;
    button.textContent = '⏳ Sagatavo...';
    
    setStatus('Sagatavojam backupu...');
    
    const response = await fetch('/api/prepare-backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoName: currentRepo, walletAddress: userAddress })
    });
    
    const result = await response.json();
    
    if (result.success) {
        currentUnchangedFiles = result.unchangedFiles || {};
        currentFiles = result.files || [];
        currentFileCostEth = result.fileCostEth || '0';
        currentPreviousHistory = result.previousHistory || [];
        currentPreviousManifestId = result.previousManifestId || null;
        currentPreviousBackupNumber = result.previousBackupNumber || null;
        
        if (result.files.length === 0) {
            setStatus('✅ Nav izmaiņu — visi faili jau ir backupēti!');
            button.disabled = false;
            button.textContent = 'Sākt backupu';
            return;
        }
        
        document.getElementById('status').innerHTML = 
            `📦 Faili: ${result.files.length}<br>` +
            `💰 Failu izmaksas: ${result.fileCostEth} ETH<br>` +
            `📄 Manifests: tiks aprēķināts pēc ZIP augšupielādes`;
        
        button.disabled = false;
        button.textContent = 'Iemaksāt par ZIP un augšupielādēt';
        button.onclick = executeZipUpload;
    } else {
        showError(result.error || 'Kļūda');
        button.disabled = false;
        button.textContent = 'Sākt backupu';
    }
}

async function executeZipUpload() {
    const button = document.getElementById('backupButton');
    button.disabled = true;
    
    try {
        if (!hasDepositedFiles) {
            const provider = new ethers.BrowserProvider(window.ethereum);
            const signer = await provider.getSigner();
            
            const treasuryContract = new ethers.Contract(CONFIG.treasuryAddress, TREASURY_ABI, provider);
            const balance = await treasuryContract.balance();
            const fileCostWei = ethers.parseEther(currentFileCostEth);
            
            if (balance < fileCostWei) {
                setStatus('Iemaksājam Treasury par ZIP...');
                button.textContent = '⏳ Iemaksā...';
                
                const tx = await signer.sendTransaction({
                    to: CONFIG.treasuryAddress,
                    value: fileCostWei
                });
                
                setStatus('Gaida iemaksas apstiprinājumu...');
                button.textContent = '⏳ Gaida...';
                await tx.wait();
                
                setStatus('✅ Iemaksa veiksmīga!');
            }
            
            hasDepositedFiles = true;
        }
        
        setStatus('Serveris veido ZIP un augšupielādē...');
        button.textContent = '⏳ ZIP...';
        
        const response = await fetch('/api/execute-backup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                repoName: currentRepo,
                files: currentFiles,
                unchangedFiles: currentUnchangedFiles,
                tokenId: currentTokenId,
                fileCostEth: currentFileCostEth,
                walletAddress: userAddress,
                previousHistory: currentPreviousHistory,
                previousManifestId: currentPreviousManifestId,
                previousBackupNumber: currentPreviousBackupNumber
            })
        });
        
        const result = await response.json();
        
        if (result.success && result.step === 'zip_uploaded') {
            currentUploadedFiles = result.uploadedFiles || [];
            currentManifest = result.manifest;
            currentManifestCostEth = result.manifestCostEth || '0';
            currentNewManifestCredits = result.newManifestCredits || '0';
            
            setStatus('✅ ZIP augšupielādēts!');
            button.textContent = 'Iemaksāt par manifestu un pabeigt';
            button.onclick = finalizeBackup;
            
            document.getElementById('status').innerHTML = 
                `✅ ZIP augšupielādēts!<br>` +
                `📄 Manifesta izmērs: ${(result.manifestSize / 1024).toFixed(2)} KB<br>` +
                `💰 Manifesta izmaksas: ${result.manifestCostEth} ETH<br><br>` +
                `Kopā: ${(parseFloat(currentFileCostEth) + parseFloat(result.manifestCostEth)).toFixed(18)} ETH`;
            
            button.disabled = false;
            
        } else {
            showError(result.error || 'Kļūda');
            button.disabled = false;
            button.textContent = 'Mēģināt vēlreiz';
        }
        
    } catch (e) {
        if (e.code === 'ACTION_REJECTED') {
            showError('Transakcija atcelta');
        } else {
            showError(e.message);
        }
        button.disabled = false;
        button.textContent = 'Iemaksāt par ZIP un augšupielādēt';
    }
}

// ============================================================
// FINALIZE BACKUP | BACKUP PABEIGŠANA
// ============================================================

async function finalizeBackup() {
    const button = document.getElementById('backupButton');
    button.disabled = true;
    
    try {
        if (!hasDepositedManifest) {
            const provider = new ethers.BrowserProvider(window.ethereum);
            const signer = await provider.getSigner();
            
            const treasuryContract = new ethers.Contract(CONFIG.treasuryAddress, TREASURY_ABI, provider);
            const balance = await treasuryContract.balance();
            const manifestCostWei = ethers.parseEther(currentManifestCostEth);
            
            if (balance < manifestCostWei) {
                setStatus('Iemaksājam Treasury par manifestu...');
                button.textContent = '⏳ Iemaksā...';
                
                const tx = await signer.sendTransaction({
                    to: CONFIG.treasuryAddress,
                    value: manifestCostWei
                });
                
                setStatus('Gaida iemaksas apstiprinājumu...');
                button.textContent = '⏳ Gaida...';
                await tx.wait();
                
                setStatus('✅ Iemaksa veiksmīga!');
            }
            
            hasDepositedManifest = true;
        }
        
        setStatus('Serveris augšupielādē manifestu...');
        button.textContent = '⏳ Manifests...';
        
        // ============================================================
        // EIP-712 PARAKSTĪŠANA | EIP-712 SIGNING
        // ============================================================
        
        const provider = new ethers.BrowserProvider(window.ethereum);
        const signer = await provider.getSigner();
        
        const nftContract = new ethers.Contract(CONFIG.nftAddress, NFT_ABI, signer);
        const readContract = new ethers.Contract(CONFIG.nftAddress, NFT_ABI, provider);
        
        const deadline = Math.floor(Date.now() / 1000) + 600;
        const currentNonce = await readContract.getNonce(currentTokenId);
        const backupNumber = await readContract.getBackupCount(currentTokenId);
        
        // MANIFEST URI (no currentManifest vai servera atbildes)
        const manifestURI = `ar://${currentManifestTxId}`;
        const manifestHash = ethers.keccak256(ethers.toUtf8Bytes(manifestURI));
        
        // Merkle sakne – aprēķina no currentUploadedFiles
        const merkleRoot = calculateMerkleRoot(currentUploadedFiles);
        
        const domain = {
            name: 'PermRepo',
            version: '1',
            chainId: parseInt(CONFIG.chainId, 16),
            verifyingContract: CONFIG.nftAddress
        };
        
        const types = {
            AddBackup: [
                { name: 'tokenId', type: 'uint256' },
                { name: 'backupNumber', type: 'uint256' },
                { name: 'manifestHash', type: 'bytes32' },
                { name: 'merkleRoot', type: 'bytes32' },
                { name: 'deadline', type: 'uint256' },
                { name: 'nonce', type: 'uint256' }
            ]
        };
        
        const value = {
            tokenId: BigInt(currentTokenId),
            backupNumber: backupNumber + 1n,
            manifestHash,
            merkleRoot,
            deadline: BigInt(deadline),
            nonce: currentNonce
        };
        
        const signature = await signer.signTypedData(domain, types, value);
        
        // ============================================================
        // FERCH UZ SERVERI | FETCH TO SERVER
        // ============================================================
        
        const response = await fetch('/api/finalize-backup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                repoName: currentRepo,
                manifest: currentManifest,
                manifestCostEth: currentManifestCostEth,
                walletAddress: userAddress,
                newManifestCredits: currentNewManifestCredits,
                tokenId: currentTokenId,
                files: currentUploadedFiles,
                signature: signature // PIEVIENO PARAKSTU
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            setStatus('✅ Manifests augšupielādēts! Ierakstam blockchain...');
            
            if (result.merkleTxHash) {
                setStatus('✅ Merkle sakne iesniegta! Transakcija: ' + result.merkleTxHash);
            }
            
            setStatus('✅ Backups veiksmīgi pabeigts!');
            button.textContent = '✅ Pabeigts!';
            
            document.getElementById('status').innerHTML = 
                `✅ Backups veiksmīgs!<br>` +
                `Manifests: <a href="${CONFIG.arweaveGateway}/raw/${result.manifestTxId}" target="_blank">ar://${result.manifestTxId}</a><br>` +
                `Faili ZIP: ${currentUploadedFiles.length}<br>` +
                `ZIP izmaksas: ${currentFileCostEth} ETH<br>` +
                `Manifesta izmaksas: ${currentManifestCostEth} ETH`;
            
        } else {
            showError(result.error || 'Kļūda');
            button.disabled = false;
            button.textContent = 'Mēģināt vēlreiz';
        }
        
    } catch (e) {
        if (e.code === 'ACTION_REJECTED') {
            showError('Transakcija atcelta');
        } else {
            showError(e.message);
        }
        button.disabled = false;
        button.textContent = 'Iemaksāt par manifestu un pabeigt';
    }
}

function setStatus(msg) { 
    document.getElementById('status').innerHTML = msg; 
}

function showError(msg) { 
    document.getElementById('error').textContent = msg; 
}

// ============================================================
// MERKLE SAKNES APRĒĶINS | MERKLE ROOT CALCULATION
// ============================================================

function calculateMerkleRoot(files) {
    // Vienkārša Merkle saknes aprēķināšana (piemēram, keccak256 no visiem failu hešiem)
    const fileHashes = files.map(file => 
        ethers.keccak256(ethers.toUtf8Bytes(file.hash || ''))
    );
    
    if (fileHashes.length === 0) {
        return '0x0000000000000000000000000000000000000000000000000000000000000000';
    }
    
    const combinedHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(['bytes32[]'], [fileHashes])
    );
    
    return combinedHash;
}

// ============================================================
// START | SĀKUMS
// ============================================================

// Inicializē lietotni | Initialize the app
init();

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('connectWalletButton').onclick = connectWallet;
});
