import { ethers } from 'ethers';

const CHAIN_ID = '0x14a34';
const TREASURY_ADDRESS = '0x349c78525Dbb6aCfE60c96546174dC1627028b62';

const params = new URLSearchParams(window.location.search);
const backupId = params.get('backupId') || '';
const repoFromUrl = params.get('repo') || '';
const amountParam = params.get('amount') || '0';

let signer, userAddress;

async function init() {
    document.getElementById('repoInput').value = repoFromUrl;
    document.getElementById('amountDisplay').textContent = amountParam + ' ETH';
    document.getElementById('treasuryAddress').textContent = TREASURY_ADDRESS;
    
    if (!backupId) {
        showError('Nav backup ID!');
        return;
    }
    
    if (!window.ethereum) {
        showError('Lūdzu instalē MetaMask!');
        return;
    }
    
    try {
        await window.ethereum.request({ 
            method: 'wallet_switchEthereumChain', 
            params: [{ chainId: CHAIN_ID }] 
        });
        
        const provider = new ethers.BrowserProvider(window.ethereum);
        signer = await provider.getSigner();
        userAddress = await signer.getAddress();
        
        const button = document.getElementById('payButton');
        button.disabled = false;
        button.textContent = 'Iemaksāt un Apstiprināt';
        button.onclick = payAndExecute;
        
        setStatus('Gatavs!');
    } catch (e) {
        showError(e.message);
    }
}

async function payAndExecute() {
    const button = document.getElementById('payButton');
    button.disabled = true;
    
    try {
        // 1. Iemaksāt Treasury
        setStatus('1/3: Iemaksājam Treasury...');
        button.textContent = '⏳ Iemaksā...';
        
        const tx = await signer.sendTransaction({
            to: TREASURY_ADDRESS,
            value: ethers.parseEther(amountParam)
        });
        
        setStatus('2/3: Gaida transakcijas apstiprinājumu...');
        button.textContent = '⏳ Gaida...';
        await tx.wait();
        
        setStatus('3/3: Izpilda backupu...');
        button.textContent = '⏳ Backups...';
        
        // 2. Izsaukt Render, lai pabeigtu backupu
        const response = await fetch('/api/execute-backup', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                backupId: backupId,
                walletAddress: userAddress
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            setStatus('✅ Backups veiksmīgs!');
            button.textContent = '✅ Pabeigts!';
            
            setTimeout(() => {
                document.getElementById('status').textContent = 
                    `✅ Backups pabeigts!\nManifests: ${result.manifestTxId}`;
            }, 1000);
            
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
