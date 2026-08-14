import { ethers } from 'ethers';
import { TurboFactory, OnDemandFunding, ETHToTokenAmount } from '@ardrive/turbo-sdk';
import { InjectedEthereumSigner } from '@dha-team/arbundles';

let CONFIG = {
    chainId: '0x14a34',
    treasuryAddress: '',
    nftAddress: '',
    subscriptionAddress: ''
};

let signer = null;
let userAddress = null;
let currentRepo = null;

async function init() {
    // Iegūt konfigurāciju no servera
    try {
        const configResponse = await fetch('/api/config');
        CONFIG = await configResponse.json();
    } catch (e) {
        console.error('Neizdevās iegūt konfigurāciju:', e.message);
    }
    
    // Pārbaudīt GitHub autorizāciju
    const userResponse = await fetch('/api/github/user');
    const userData = await userResponse.json();
    
    if (userData.success) {
        showUserSection(userData);
        await loadRepos();
    } else {
        showAuthSection();
    }
    
    // Savienot ar MetaMask
    if (window.ethereum) {
        try {
            await window.ethereum.request({ 
                method: 'wallet_switchEthereumChain', 
                params: [{ chainId: CONFIG.chainId }] 
            });
            
            const provider = new ethers.BrowserProvider(window.ethereum);
            signer = await provider.getSigner();
            userAddress = await signer.getAddress();
            document.getElementById('walletInput').value = userAddress;
        } catch (e) {
            console.error('MetaMask savienojuma kļūda:', e.message);
        }
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
            if (select.value) {
                await checkRepoStatus(select.value);
            }
        };
    } else {
        showError('Nav repozitoriju');
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
        if (result.hasNFT) {
            document.getElementById('nftStatus').textContent = '✅ NFT atrasts';
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
        
        if (result.hasNFT && result.hasSubscription) {
            backupButton.style.display = 'block';
            backupButton.disabled = false;
            backupButton.textContent = 'Sākt backupu';
            backupButton.onclick = prepareBackup;
        } else {
            backupButton.style.display = 'none';
        }
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
        setStatus('Augšupielādējam Arweave...');
        await uploadFilesWithMetaMask(result.files, result.repoName);
    } else {
        showError(result.error || 'Kļūda');
        button.disabled = false;
        button.textContent = 'Sākt backupu';
    }
}

async function uploadFilesWithMetaMask(files, repoName) {
    const button = document.getElementById('backupButton');
    button.textContent = '⏳ Augšupielādē...';
    
    try {
        // Izveidot Turbo klientu ar MetaMask signer
        const turbo = TurboFactory.authenticated({
            signer: new InjectedEthereumSigner({ getSigner: () => signer }),
            token: 'base-eth',
        });
        
        const uploadResults = [];
        
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const fileBuffer = Buffer.from(file.content, 'base64');
            
            setStatus(`Augšupielādējam ${i + 1}/${files.length}: ${file.path}`);
            
            try {
                const result = await turbo.uploadFile({
                    fileStreamFactory: () => fileBuffer,
                    fileSizeFactory: () => fileBuffer.length,
                    fundingMode: new OnDemandFunding({
                        maxTokenAmount: ETHToTokenAmount(0.001), // Max 0.001 ETH
                    }),
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
        
        // Visi faili augšupielādēti!
        setStatus('✅ Visi faili augšupielādēti!');
        button.textContent = '✅ Pabeigts!';
        
        document.getElementById('status').textContent = 
            `✅ Backups veiksmīgs!\n` +
            `Faili: ${uploadResults.length}\n` +
            `Kopējais izmērs: ${formatBytes(uploadResults.reduce((sum, f) => sum + f.size, 0))}`;
        
        console.log('Upload results:', uploadResults);
        
    } catch (e) {
        console.error('Augšupielādes kļūda:', e.message);
        showError('Augšupielāde neizdevās: ' + e.message);
        button.disabled = false;
        button.textContent = 'Sākt backupu';
    }
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function setStatus(msg) { 
    document.getElementById('status').textContent = msg; 
}

function showError(msg) { 
    document.getElementById('error').textContent = msg; 
}

init();
