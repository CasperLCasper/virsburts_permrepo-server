const { ethers } = window;

let CONFIG = {};

const NFT_ABI = [
    "function mintRepository(address recipient, string calldata repository, bool privateRepo) external returns (uint256)",
    "function repositoryTokens(bytes32 repoHash) external view returns (uint256)"
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
        
        const button = document.getElementById('mintButton');
        button.disabled = false;
        button.textContent = 'Izveidot NFT';
        button.onclick = mintNFT;
        
        setStatus('Gatavs!');
    } catch (e) {
        showError(e.message);
    }
}

async function mintNFT() {
    const repo = document.getElementById('repoInput').value.trim();
    
    if (!repo) {
        showError('Ievadi repo nosaukumu!');
        return;
    }
    
    const button = document.getElementById('mintButton');
    button.disabled = true;
    button.textContent = '⏳ Kal...';
    
    try {
        setStatus('1/3: Pārbaudam, vai NFT jau eksistē...');
        
        const provider = new ethers.BrowserProvider(window.ethereum);
        const repoHash = ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(['string'], [repo])
        );
        
        const nftContract = new ethers.Contract(CONFIG.nftAddress, NFT_ABI, provider);
        const tokenId = await nftContract.repositoryTokens(repoHash);
        
        if (tokenId !== 0n && tokenId !== 0) {
            showError('NFT jau eksistē šim repo!');
            button.disabled = false;
            button.textContent = 'Izveidot NFT';
            return;
        }
        
        setStatus('2/3: Gaida transakcijas apstiprinājumu...');
        button.textContent = '⏳ Gaida...';
        
        const signerContract = new ethers.Contract(CONFIG.nftAddress, NFT_ABI, signer);
        const tx = await signerContract.mintRepository(userAddress, repo, false);
        await tx.wait();
        
        setStatus('3/3: Pārbaudam rezultātu...');
        
        const newTokenId = await nftContract.repositoryTokens(repoHash);
        
        setStatus('✅ NFT izveidots!');
        button.textContent = '✅ Pabeigts!';
        
        document.getElementById('status').textContent = 
            `✅ NFT izveidots!\nToken ID: ${newTokenId.toString()}`;
        
    } catch (e) {
        if (e.code === 'ACTION_REJECTED') {
            showError('Transakcija atcelta');
        } else {
            showError(e.message);
        }
        button.disabled = false;
        button.textContent = 'Izveidot NFT';
    }
}

function setStatus(msg) { document.getElementById('status').textContent = msg; }
function showError(msg) { document.getElementById('error').textContent = msg; }

init();
