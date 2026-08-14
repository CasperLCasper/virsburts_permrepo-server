import { ethers } from 'ethers';

const CHAIN_ID = '0x14a34';

const NFT_ADDRESS = '0xeD3eB455cAeb057a034d7bE2368cdCEA37Faa1d4';

const NFT_ABI = [
    "function mintRepository(address recipient, string calldata repository, bool privateRepo) external returns (uint256)",
    "function repositoryTokens(bytes32 repoHash) external view returns (uint256)"
];

const params = new URLSearchParams(window.location.search);
const repoFromUrl = params.get('repo') || '';

let signer;
let userAddress;

async function init() {
    document.getElementById('repoInput').value = repoFromUrl;
    
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
        
        const nftContract = new ethers.Contract(NFT_ADDRESS, NFT_ABI, provider);
        const tokenId = await nftContract.repositoryTokens(repoHash);
        
        if (tokenId !== 0n && tokenId !== 0) {
            showError('NFT jau eksistē šim repo!');
            button.disabled = false;
            button.textContent = 'Izveidot NFT';
            return;
        }
        
        setStatus('2/3: Gaida transakcijas apstiprinājumu...');
        button.textContent = '⏳ Gaida...';
        
        const signerContract = new ethers.Contract(NFT_ADDRESS, NFT_ABI, signer);
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
