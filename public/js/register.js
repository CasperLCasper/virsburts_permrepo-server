const { ethers } = window;

let CONFIG = {};

const NFT_ABI = [
    "function repositoryTokens(bytes32 repoHash) external view returns (uint256)"
];

const REGISTRY_ABI = [
    "function registerRepository(bytes32 repositoryId, uint256 nftTokenId) external",
    "function repositories(bytes32 repositoryId) external view returns (bytes32 repositoryId, uint256 nftTokenId, uint256 createdAt, bool active)"
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
        
        const button = document.getElementById('registerButton');
        button.disabled = false;
        button.textContent = 'Reģistrēt repo';
        button.onclick = registerRepo;
        
        setStatus('Gatavs!');
    } catch (e) {
        showError(e.message);
    }
}

async function registerRepo() {
    const repo = document.getElementById('repoInput').value.trim();
    
    if (!repo) {
        showError('Ievadi repo nosaukumu!');
        return;
    }
    
    const button = document.getElementById('registerButton');
    button.disabled = true;
    button.textContent = '⏳ Reģistrē...';
    
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
            button.textContent = 'Reģistrēt repo';
            return;
        }
        
        setStatus('2/4: Pārbaudam, vai jau reģistrēts...');
        
        const registryContract = new ethers.Contract(CONFIG.registryAddress, REGISTRY_ABI, provider);
        const existing = await registryContract.repositories(repoHash);
        
        if (existing.active) {
            showError('Repo jau ir reģistrēts!');
            button.disabled = false;
            button.textContent = 'Reģistrēt repo';
            return;
        }
        
        setStatus('3/4: Gaida transakcijas apstiprinājumu...');
        button.textContent = '⏳ Gaida...';
        
        const signerRegistry = new ethers.Contract(CONFIG.registryAddress, REGISTRY_ABI, signer);
        const tx = await signerRegistry.registerRepository(repoHash, tokenId);
        await tx.wait();
        
        setStatus('4/4: Pārbaudam rezultātu...');
        
        const registered = await registryContract.repositories(repoHash);
        
        if (registered.active) {
            setStatus('✅ Repo veiksmīgi reģistrēts!');
            button.textContent = '✅ Pabeigts!';
        } else {
            showError('Reģistrācija neizdevās');
            button.disabled = false;
            button.textContent = 'Reģistrēt repo';
        }
        
    } catch (e) {
        if (e.code === 'ACTION_REJECTED') {
            showError('Transakcija atcelta');
        } else {
            showError(e.message);
        }
        button.disabled = false;
        button.textContent = 'Reģistrēt repo';
    }
}

function setStatus(msg) { document.getElementById('status').textContent = msg; }
function showError(msg) { document.getElementById('error').textContent = msg; }

init();
