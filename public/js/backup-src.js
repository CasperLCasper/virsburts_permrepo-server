const { ethers } = window;

let CONFIG = {};
let userAddress = null;
let currentRepo = null;
let currentTokenId = '0';
let currentUnchangedFiles = {};
let currentFiles = [];
let currentCostEth = '0';
let currentPreviousHistory = [];
let currentPreviousManifestId = null;
let currentPreviousBackupNumber = null;
let hasDeposited = false;

const NFT_ABI = [
    "function addBackup(uint256 tokenId, bytes32 manifestHash, bytes32 merkleRoot, string calldata manifestURI, uint256 deadline, bytes calldata signature) external",
    "function getNonce(uint256 tokenId) external view returns (uint256)",
    "function getBackupCount(uint256 tokenId) external view returns (uint256)"
];

const TREASURY_ABI = [
    "function balance() external view returns (uint256)"
];

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
    hasDeposited = false;
    
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
        currentCostEth = result.costEth || '0';
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
            `💰 Izmaksas: ${result.costEth} ETH`;
        
        button.disabled = false;
        button.textContent = 'Izpildīt backupu';
        button.onclick = executeBackup;
    } else {
        showError(result.error || 'Kļūda');
        button.disabled = false;
        button.textContent = 'Sākt backupu';
    }
}

async function executeBackup() {
    const button = document.getElementById('backupButton');
    button.disabled = true;
    
    try {
        if (!hasDeposited) {
            const provider = new ethers.BrowserProvider(window.ethereum);
            const signer = await provider.getSigner();
            
            const treasuryContract = new ethers.Contract(CONFIG.treasuryAddress, TREASURY_ABI, provider);
            const balance = await treasuryContract.balance();
            const costWei = ethers.parseEther(currentCostEth);
            
            if (balance < costWei) {
                setStatus('Iemaksājam Treasury...');
                const tx = await signer.sendTransaction({ to: CONFIG.treasuryAddress, value: costWei });
                await tx.wait();
                setStatus('✅ Iemaksa veiksmīga!');
            }
            hasDeposited = true;
        }
        
        setStatus('Serveris apmaksā un augšupielādē...');
        
        const response = await fetch('/api/execute-backup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                repoName: currentRepo,
                files: currentFiles,
                unchangedFiles: currentUnchangedFiles,
                tokenId: currentTokenId,
                costEth: currentCostEth,
                walletAddress: userAddress,
                previousHistory: currentPreviousHistory,
                previousManifestId: currentPreviousManifestId,
                previousBackupNumber: currentPreviousBackupNumber
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            await addBackupToBlockchain(currentTokenId, result.manifestTxId);
            
            setStatus('✅ Backups veiksmīgi pabeigts!');
            button.textContent = '✅ Pabeigts!';
            
            document.getElementById('status').innerHTML = 
                `✅ Backups veiksmīgs!<br>` +
                `Manifests: <a href="${CONFIG.arweaveGateway}/raw/${result.manifestTxId}" target="_blank">ar://${result.manifestTxId}</a><br>` +
                `Faili: ${result.uploadedFiles.length}<br>` +
                `Izmaksas: ${result.costEth} ETH`;
        } else {
            showError(result.error || 'Kļūda');
            button.disabled = false;
        }
        
    } catch (e) {
        if (e.code === 'ACTION_REJECTED') {
            showError('Transakcija atcelta');
        } else {
            showError(e.message);
        }
        button.disabled = false;
    }
}

async function addBackupToBlockchain(tokenId, manifestTxId) {
    const provider = new ethers.BrowserProvider(window.ethereum);
    const signerContract = await provider.getSigner();
    
    const nftContract = new ethers.Contract(CONFIG.nftAddress, NFT_ABI, signerContract);
    const readContract = new ethers.Contract(CONFIG.nftAddress, NFT_ABI, provider);
    
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const currentNonce = await readContract.getNonce(tokenId);
    const backupNumber = await readContract.getBackupCount(tokenId);
    
    const manifestURI = `ar://${manifestTxId}`;
    const manifestHash = ethers.keccak256(new TextEncoder().encode(manifestURI));
    const merkleRoot = '0x0000000000000000000000000000000000000000000000000000000000000000';
    
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
        tokenId,
        backupNumber: backupNumber + 1n,
        manifestHash,
        merkleRoot,
        deadline: BigInt(deadline),
        nonce: currentNonce
    };
    
    const signature = await signerContract.signTypedData(domain, types, value);
    const tx = await nftContract.addBackup(tokenId, manifestHash, merkleRoot, manifestURI, deadline, signature);
    await tx.wait();
    return tx.hash;
}

function setStatus(msg) { 
    document.getElementById('status').innerHTML = msg; 
}

function showError(msg) { 
    document.getElementById('error').textContent = msg; 
}

init();

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('connectWalletButton').onclick = connectWallet;
});
