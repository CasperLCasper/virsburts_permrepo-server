// merkle.js
// Merkle saknes aprēķins un iesniegšana NFT līgumā
// Calculation and submission of Merkle root to the NFT contract

import { ethers } from 'ethers';

const NFT_ABI = [
    "function repositoryTokens(bytes32 repoHash) external view returns (uint256)",
    "function ownerOf(uint256 tokenId) external view returns (address)",
    "function getBackupCount(uint256 tokenId) external view returns (uint256)",
    "function getManifestURI(uint256 tokenId) external view returns (string)",
    "function getNonce(uint256 tokenId) external view returns (uint256)",
    "function addBackup(uint256 tokenId, bytes32 manifestHash, bytes32 merkleRoot, string calldata manifestURI, uint256 deadline, bytes calldata signature) external"
];

/**
 * Aprēķina Merkle sakni (filesHash) no failu hešu saraksta.
 * Calculates the Merkle root (filesHash) from a list of file hashes.
 * 
 * @param {Array} files - failu masīvs ar lauku { hash: string }.
 *                         Array of files with field { hash: string }.
 * @returns {string} - keccak256(concat(all hashes)).
 */
export function calculateMerkleRoot(files) {
    if (!files || !Array.isArray(files) || files.length === 0) {
        return '0x0000000000000000000000000000000000000000000000000000000000000000';
    }

    const fileHashes = files.map(file => 
        ethers.keccak256(ethers.toUtf8Bytes(file.hash || ''))
    );

    const combinedHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(['bytes32[]'], [fileHashes])
    );

    return combinedHash;
}

/**
 * Izsauc NFT līguma addBackup() funkciju ar reālu merkleRoot.
 * Calls the NFT contract's addBackup() function with a real merkleRoot.
 * 
 * @param {Object} params - { tokenId, manifestTxId, manifest, files, deadline, signature, nftContract }.
 * @returns {Promise<Object>} - { txHash, merkleRoot, manifestURI, manifestHash, receipt }.
 */
export async function submitBackupWithMerkle(params) {
    const { 
        tokenId, 
        manifestTxId, 
        manifest,      // Manifesta objekts, ja pieejams
        files, 
        deadline, 
        signature, 
        nftContract
    } = params;

    console.log('\n' + '='.repeat(60));
    console.log('📝 SUBMIT BACKUP WITH MERKLE');
    console.log('='.repeat(60));
    console.log('   Token ID:', tokenId);
    console.log('   Manifest TX ID:', manifestTxId);
    console.log('   Files count:', files ? files.length : 0);
    console.log('   Manifest provided:', manifest ? '✅ Yes' : '❌ No');

    // 1. Aprēķini Merkle sakni.
    //    Calculate Merkle root.
    const merkleRoot = calculateMerkleRoot(files);
    console.log('   Merkle root:', merkleRoot);

    // 2. Sagatavo manifest URI un hešu.
    //    Prepare manifest URI and hash.
    const manifestURI = `ar://${manifestTxId}`;
    
    // Aprēķina manifestHash no manifesta satura, ja tas ir pieejams
    let manifestHash;
    if (manifest) {
        // Ja manifests ir nodots, aprēķina hash no tā satura
        const manifestString = JSON.stringify(manifest);
        manifestHash = ethers.keccak256(ethers.toUtf8Bytes(manifestString));
        console.log('   Manifest hash (from content):', manifestHash);
    } else {
        // Fallback uz URI hash
        manifestHash = ethers.keccak256(ethers.toUtf8Bytes(manifestURI));
        console.log('   Manifest hash (from URI):', manifestHash);
    }

    // 3. Pārbauda, vai paraksts ir nodots.
    //    Check if signature is provided.
    if (!signature || signature === '0x') {
        throw new Error('Nav paraksta (signature) | No signature provided');
    }
    console.log('   Signature:', signature.substring(0, 30) + '...');

    // 4. Pārbauda, vai nftContract ir nodots.
    //    Check if nftContract is provided.
    if (!nftContract) {
        throw new Error('Nav NFT kontrakta | No NFT contract provided');
    }

    // 5. Izsauc addBackup() ar nodotajiem parametriem.
    //    Call addBackup() with provided parameters.
    console.log('   📤 Calling addBackup()...');
    
    try {
        const tx = await nftContract.addBackup(
            tokenId,
            manifestHash,
            merkleRoot,
            manifestURI,
            deadline,
            signature,
            { gasLimit: 500000 }  // Pievieno gas limitu
        );
        
        console.log('   ✅ Transaction sent:', tx.hash);
        
        const receipt = await tx.wait();
        
        if (receipt.status === 1) {
            console.log('   ✅ addBackup successful! Gas used:', receipt.gasUsed.toString());
            console.log('   Block number:', receipt.blockNumber);
        } else {
            throw new Error('addBackup transakcija neizdevās | addBackup transaction failed');
        }
        
        return {
            txHash: tx.hash,
            merkleRoot,
            manifestURI,
            manifestHash,
            receipt
        };
        
    } catch (error) {
        console.error('   ❌ addBackup error:', error.message);
        throw error;
    }
}
