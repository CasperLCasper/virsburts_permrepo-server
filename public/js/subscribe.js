const { ethers } = window;

let CONFIG = {};

const NFT_ABI = [
    "function repositoryTokens(bytes32 repoHash) external view returns (uint256)"
];

const SUBSCRIPTION_ABI = [
    "function subscribe(uint256 tokenId) external",
    "function isSubscribed(uint256 tokenId) external view returns (bool)"
];

const USDC_ABI = [
    "function approve(address spender, uint256 amount) external returns (bool)"
];

const params = new URLSearchParams(window.location.search);
const repoFromUrl = params.get('repo') || '';

let signer;
let userAddress;

async function init() {
    try {
        const configResponse = await fetch('/api/config');
        CONFIG = await configResponse.json();
    } catch (e) {
        console.error('Neizdevās iegūt konfigurāciju:', e.message);
        showError('Neizdevās iegūt konfigurāciju');
        return;
    }
    
    document.getElementById('repoInput').value = repoFromUrl;
    
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
        signer = await provider.getSigner();
        userAddress = await signer.getAddress();
        
        const button = document.getElementById('subscribeButton');
        button.disabled = false;
        button.textContent = 'Iegādāties abonementu';
        button.onclick = subscribe;
        
        setStatus('Gatavs!');
    } catch (e) {
        showError(e.message);
    }
}

async function subscribe() {
    const repo = document.getElementById('repoInput').value.trim();
    
    if (!repo) {
        showError('Ievadi repo nosaukumu!');
        return;
    }
    
    const button = document.getElementById('subscribeButton');
    button.disabled = true;
    
    try {
        setStatus('1/4: Meklējam NFT...');
        
        const provider = new ethers.BrowserProvider(window.ethereum);
        const repoHash = ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(['string'], [repo])
        );
        
        const nftContract = new ethers.Contract(CONFIG.nftAddress, NFT_ABI, provider);
        const tokenId = await nftContract.repositoryTokens(repoHash);
        
        if (tokenId === 0n || tokenId === 0) {
            showError('Nav NFT šim repo! Vispirms izveido NFT.');
            button.disabled = false;
            button.textContent = 'Iegādāties abonementu';
            return;
        }
        
        setStatus('2/4: Apstiprina USDC atļauju...');
        button.textContent = '⏳ USDC...';
        
        const usdcContract = new ethers.Contract(CONFIG.usdcAddress, USDC_ABI, signer);
        const approveTx = await usdcContract.approve(CONFIG.subscriptionAddress, 2000000);
        await approveTx.wait();
        
        setStatus('3/4: Pērk abonementu...');
        button.textContent = '⏳ Pērk...';
        
        const subscriptionContract = new ethers.Contract(CONFIG.subscriptionAddress, SUBSCRIPTION_ABI, signer);
        const subscribeTx = await subscriptionContract.subscribe(tokenId);
        await subscribeTx.wait();
        
        setStatus('4/4: Pārbaudam statusu...');
        
        const isActive = await subscriptionContract.isSubscribed(tokenId);
        
        if (isActive) {
            setStatus('✅ Abonements aktīvs!');
            button.textContent = '✅ Pabeigts!';
        } else {
            showError('Abonements nav aktīvs');
            button.disabled = false;
            button.textContent = 'Iegādāties abonementu';
        }
        
    } catch (e) {
        if (e.code === 'ACTION_REJECTED') {
            showError('Transakcija atcelta');
        } else {
            showError(e.message);
        }
        button.disabled = false;
        button.textContent = 'Iegādāties abonementu';
    }
}

function setStatus(msg) { document.getElementById('status').textContent = msg; }
function showError(msg) { document.getElementById('error').textContent = msg; }

init();
