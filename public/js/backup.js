import { ethers } from 'ethers';

let CONFIG = {
    chainId: '0x14a34',
    treasuryAddress: '',
    nftAddress: '',
    subscriptionAddress: ''
};

let githubToken = null;
let walletAddress = null;
let signer = null;
let currentBackupId = null;
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
    
    // Pārbaudīt, vai ir wallet
    if (window.ethereum) {
        const provider = new ethers.BrowserProvider(window.ethereum);
        signer = await provider.getSigner();
        walletAddress = await signer.getAddress();
        document.getElementById('walletInput').value = walletAddress;
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
            walletAddress
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
            walletAddress
        })
    });
    
    const result = await response.json();
    
    if (result.success) {
        currentBackupId = result.backupId;
        
        document.getElementById('paymentSection').style.display = 'block';
        document.getElementById('amountDisplay').textContent = result.costEth + ' ETH';
        
        const payButton = document.getElementById('payButton');
        payButton.onclick = payAndExecute;
        
        setStatus('Backups sagatavots! Iemaksā apmaksu.');
    } else {
        showError(result.error || 'Kļūda');
        button.disabled = false;
        button.textContent = 'Sākt backupu';
    }
}

async function payAndExecute() {
    const button = document.getElementById('payButton');
    button.disabled = true;
    
    try {
        setStatus('1/3: Iemaksājam Treasury...');
        
        const amount = document.getElementById('amountDisplay').textContent.replace(' ETH', '');
        
        const tx = await signer.sendTransaction({
            to: CONFIG.treasuryAddress,
            value: ethers.parseEther(amount)
        });
        
        setStatus('2/3: Gaida apstiprinājumu...');
        await tx.wait();
        
        setStatus('3/3: Izpilda backupu...');
        
        const response = await fetch('/api/execute-backup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                backupId: currentBackupId,
                walletAddress
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            setStatus('✅ Backups veiksmīgs!');
            document.getElementById('status').textContent = 
                '✅ Backups pabeigts!\nManifests: ' + result.manifestTxId;
            button.textContent = '✅ Pabeigts!';
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
        button.textContent = 'Iemaksāt un Apstiprināt';
    }
}

function setStatus(msg) { document.getElementById('status').textContent = msg; }
function showError(msg) { document.getElementById('error').textContent = msg; }

init();
