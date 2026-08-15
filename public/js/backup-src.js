const { ethers } = window;

import { TurboFactory, ETHToTokenAmount } from '@ardrive/turbo-sdk/web';
import { InjectedEthereumSigner } from '@dha-team/arbundles/web';

let CONFIG = {};
let userAddress = null;
let currentRepo = null;
let currentTokenId = '0';
let currentUnchangedFiles = {};

const NFT_ABI = [
    "function addBackup(uint256 tokenId, bytes32 manifestHash, bytes32 merkleRoot, string calldata manifestURI, uint256 deadline, bytes calldata signature) external",
    "function getNonce(uint256 tokenId) external view returns (uint256)",
    "function getBackupCount(uint256 tokenId) external view returns (uint256)"
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
    
    const statusSection = document.getElementById('statusSection');
    statusSection.style.display = 'block';
    
    document.getElementById('nftStatus').textContent = '⏳ Pārbauda NFT...';
    document.getElementById('subscriptionStatus').textContent = '⏳ Pārbauda abonementu...';
    
    const response = await fetch('/api/check-repo-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            repoName,
            walletAddress: userAddress
        })
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
        body: JSON.stringify({
            repoName: currentRepo,
            walletAddress: userAddress
        })
    });
    
    const result = await response.json();
    
    if (result.success) {
        currentUnchangedFiles = result.unchangedFiles || {};
        
        if (result.files.length === 0) {
            setStatus('✅ Nav izmaiņu — visi faili jau ir backupēti!');
            button.disabled = false;
            button.textContent = 'Sākt backupu';
            return;
        }
        
        setStatus(`Augšupielādējam ${result.files.length} failus...`);
        await uploadFilesWithMetaMask(result.files, result.repoName, result.tokenId);
    } else {
        showError(result.error || 'Kļūda');
        button.disabled = false;
        button.textContent = 'Sākt backupu';
    }
}

async function uploadFilesWithMetaMask(files, repoName, tokenId) {
    const button = document.getElementById('backupButton');
    button.textContent = '⏳ Augšupielādē...';
    
    try {
        const provider = new ethers.BrowserProvider(window.ethereum);
        const signer = await provider.getSigner();
        
        const turbo = TurboFactory.authenticated({
            signer: new InjectedEthereumSigner({ getSigner: () => signer }),
            token: 'base-eth',
        });
        
        // 1. Top up kredītus
        setStatus('1/2: Pērkam kredītus...');
        await turbo.topUpWithTokens({
            tokenAmount: ETHToTokenAmount(0.0001),
        });
        
        // 2. Augšupielādēt failus
        setStatus('2/2: Augšupielādējam failus...');
        
        const uploadResults = [];
        
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const binaryString = atob(file.content);
            const bytes = new Uint8Array(binaryString.length);
            for (let j = 0; j < binaryString.length; j++) {
                bytes[j] = binaryString.charCodeAt(j);
            }
            
            setStatus(`Augšupielādējam ${i + 1}/${files.length}: ${file.path}`);
            
            try {
                const result = await turbo.uploadFile({
                    fileStreamFactory: () => bytes,
                    fileSizeFactory: () => bytes.length,
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
                
                console.log(`[${i + 1}/${files.length}] ✅ ${file.path}: ${result.id}`);
                
            } catch (uploadError) {
                console.error(`[${i + 1}/${files.length}] ❌ ${file.path}:`, uploadError.message);
                
                if (uploadError.code === 'ACTION_REJECTED') {
                    showError('Transakcija atcelta MetaMask');
                    button.disabled = false;
                    button.textContent = 'Sākt backupu';
                    return;
                }
                
                throw uploadError;
            }
        }
        
        setStatus('Veidojam manifestu...');
        
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
        
        for (const [fp, info] of Object.entries(currentUnchangedFiles)) {
            manifest.paths[fp] = { id: info.txId };
        }
        
        const manifestString = JSON.stringify(manifest, null, 2);
        const manifestBytes = new TextEncoder().encode(manifestString);
        const manifestResult = await turbo.uploadFile({
            fileStreamFactory: () => manifestBytes,
            fileSizeFactory: () => manifestBytes.length,
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
        console.log('Manifests:', manifestTxId);
        
        setStatus('Aprēķinam Merkle root...');
        const merkleRoot = calculateMerkleRoot(manifest.paths);
        const manifestHash = ethers.keccak256(new TextEncoder().encode(manifestString));
        
        setStatus('Ierakstam backupu blockchain...');
        await addBackupToBlockchain(
            tokenId,
            manifestHash,
            merkleRoot,
            `ar://${manifestTxId}`
        );
        
        setStatus('✅ Backups veiksmīgi pabeigts!');
        button.textContent = '✅ Pabeigts!';
        
        document.getElementById('status').innerHTML = 
            `✅ Backups veiksmīgs!<br>` +
            `Faili: ${uploadResults.length} jauni + ${Object.keys(currentUnchangedFiles).length} nemainīti<br>` +
            `Manifests: ar://${manifestTxId}<br>` +
            `Merkle Root: ${merkleRoot.substring(0, 20)}...`;
        
    } catch (e) {
        console.error('Augšupielādes kļūda:', e.message);
        showError('Augšupielāde neizdevās: ' + e.message);
        button.disabled = false;
        button.textContent = 'Sākt backupu';
    }
}

function calculateMerkleRoot(paths) {
    const entries = Object.entries(paths).sort(([a], [b]) => a.localeCompare(b));
    
    if (entries.length === 0) {
        return '0x0000000000000000000000000000000000000000000000000000000000000000';
    }
    
    if (entries.length === 1) {
        const [path, info] = entries[0];
        return ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(
                ['string', 'string'],
                [path, info.id]
            )
        );
    }
    
    let currentLevel = entries.map(([path, info]) => {
        return ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(
                ['string', 'string'],
                [path, info.id]
            )
        );
    });
    
    while (currentLevel.length > 1) {
        const nextLevel = [];
        for (let i = 0; i < currentLevel.length; i += 2) {
            const left = currentLevel[i];
            const right = currentLevel[i + 1] || left;
            nextLevel.push(
                ethers.keccak256(
                    ethers.AbiCoder.defaultAbiCoder().encode(
                        ['bytes32', 'bytes32'],
                        [left, right]
                    )
                )
            );
        }
        currentLevel = nextLevel;
    }
    
    return currentLevel[0];
}

async function addBackupToBlockchain(tokenId, manifestHash, merkleRoot, manifestURI) {
    const provider = new ethers.BrowserProvider(window.ethereum);
    const signerContract = await provider.getSigner();
    
    const nftContract = new ethers.Contract(CONFIG.nftAddress, NFT_ABI, signerContract);
    
    const deadline = Math.floor(Date.now() / 1000) + 600;
    
    const readContract = new ethers.Contract(CONFIG.nftAddress, NFT_ABI, provider);
    const currentNonce = await readContract.getNonce(tokenId);
    const backupNumber = await readContract.getBackupCount(tokenId);
    
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
        tokenId: tokenId,
        backupNumber: backupNumber + 1n,
        manifestHash: manifestHash,
        merkleRoot: merkleRoot,
        deadline: BigInt(deadline),
        nonce: currentNonce
    };
    
    const signature = await signerContract.signTypedData(domain, types, value);
    
    const tx = await nftContract.addBackup(
        tokenId,
        manifestHash,
        merkleRoot,
        manifestURI,
        deadline,
        signature
    );
    
    await tx.wait();
    console.log('addBackup transakcija veiksmīga:', tx.hash);
    
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
