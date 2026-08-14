import { ethers } from 'ethers';

const CHAIN_ID = '0x14a34';
const TREASURY_ADDRESS = '0x349c78525Dbb6aCfE60c96546174dC1627028b62';

const params = new URLSearchParams(window.location.search);
const repoFromUrl = params.get('repo') || '';
const amountParam = params.get('amount') || '0.000001';

let signer, userAddress;

async function init() {
    document.getElementById('repoInput').value = repoFromUrl;
    document.getElementById('amountDisplay').textContent = amountParam + ' ETH';
    document.getElementById('treasuryAddress').textContent = TREASURY_ADDRESS;
    
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
        button.textContent = 'Iemaksāt un Parakstīt';
        button.onclick = payAndSign;
        
        setStatus('Gatavs!');
    } catch (e) {
        showError(e.message);
    }
}

async function payAndSign() {
    const repo = document.getElementById('repoInput').value.trim();
    
    if (!repo) {
        showError('Ievadi repo nosaukumu!');
        return;
    }
    
    const button = document.getElementById('payButton');
    button.disabled = true;
    button.textContent = '⏳ Iemaksā...';
    
    try {
        setStatus('1/3: Iemaksājam Treasury...');
        const tx = await signer.sendTransaction({
            to: TREASURY_ADDRESS,
            value: ethers.parseEther(amountParam)
        });
        
        setStatus('2/3: Gaida transakcijas apstiprinājumu...');
        await tx.wait();
        
        setStatus('3/3: Parakstām autorizāciju...');
        button.textContent = '⏳ Paraksta...';
        
        const timestamp = Math.floor(Date.now() / 1000);
        const message = [
            'PermRepo Backup Authorization',
            `Repository: ${repo}`,
            `Timestamp: ${timestamp}`,
            `Address: ${userAddress}`
        ].join('\n');
        
        const signature = await signer.signMessage(message);
        
        const payload = {
            address: userAddress,
            signature: signature,
            message: message,
            timestamp: timestamp
        };
        
        const jsonBody = JSON.stringify(payload, null, 2);
        const body = '```json\n' + jsonBody + '\n```';
        const issueTitle = `[PermRepo Backup] ${userAddress.substring(0, 10)}...`;
        const issueUrl = `https://github.com/${repo}/issues/new?title=${encodeURIComponent(issueTitle)}&body=${encodeURIComponent(body)}`;
        
        setStatus('✅ Gatavs! Novirzam uz GitHub...');
        setTimeout(() => { window.location.href = issueUrl; }, 1500);
        
    } catch (e) {
        if (e.code === 'ACTION_REJECTED') {
            showError('Transakcija atcelta');
        } else {
            showError(e.message);
        }
        button.disabled = false;
        button.textContent = 'Iemaksāt un Parakstīt';
    }
}

function setStatus(msg) { document.getElementById('status').textContent = msg; }
function showError(msg) { document.getElementById('error').textContent = msg; }

init();
