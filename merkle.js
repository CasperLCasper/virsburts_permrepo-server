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
    const fileHashes = files.map(file => 
        ethers.keccak256(ethers.toUtf8Bytes(file.hash || ''))
    );

    if (fileHashes.length === 0) {
        return '0x0000000000000000000000000000000000000000000000000000000000000000';
    }

    const combinedHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(['bytes32[]'], [fileHashes])
    );

    return combinedHash;
}

/**
 * Izsauc NFT līguma addBackup() funkciju ar reālu merkleRoot.
 * Calls the NFT contract's addBackup() function with a real merkleRoot.
 * 
 * @param {Object} params - { tokenId, manifestTxId, files, deadline, signature, nftContract, readContract }.
 * @returns {Promise<string>} - transakcijas hash / transaction hash.
 */
export async function submitBackupWithMerkle(params) {
    const { 
        tokenId, 
        manifestTxId, 
        files, 
        deadline, 
        signature, 
        nftContract, 
        readContract 
    } = params;

    // 1. Aprēķini Merkle sakni.
    //    Calculate Merkle root.
    const merkleRoot = calculateMerkleRoot(files);

    // 2. Sagatavo manifest URI un hešu.
    //    Prepare manifest URI and hash.
    const manifestURI = `ar://${manifestTxId}`;
    const manifestHash = ethers.keccak256(ethers.toUtf8Bytes(manifestURI));

    // 3. Iegūst pašreizējo nonce un backupNumber.
    //    Get current nonce and backupNumber.
    const currentNonce = await readContract.getNonce(tokenId);
    const backupNumber = await readContract.getBackupCount(tokenId);

    // 4. Pārbauda, vai paraksts ir nodots (no priekšpuses).
    //    Check if signature is provided (from frontend).
    if (!signature || signature === '0x') {
        throw new Error('Nav paraksta (signature) | No signature provided');
    }

    // 5. Izsauc addBackup().
    //    Call addBackup().
    const tx = await nftContract.addBackup(
        tokenId,
        manifestHash,
        merkleRoot,
        manifestURI,
        deadline,
        signature
    );

    await tx.wait();
    return tx.hash;
}
